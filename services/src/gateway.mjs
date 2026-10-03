// SPDX-License-Identifier: AGPL-3.0-or-later
import { createHash } from "node:crypto";
import {
  parseUploadIntent,
  parseStorageReceipt,
  S3D_REVISION,
  UPLOAD_PART_BYTES,
} from "../../packages/browser/src/shipping-receipts.mjs";
import {
  openDatabase,
  acquireGatewayOwnership,
  bindDatabaseIdentity,
  transaction,
  OwnerAuth,
  exact,
  hex,
  fail,
  digest,
  signEnvelope,
  verifyEnvelope,
  publicHex,
} from "./common.mjs";
export class FilesGateway {
  constructor({
    databasePath,
    ownershipDirectory,
    privateKey,
    allowedOrigins,
    indexServiceIds,
    storageAccountId,
    allowedMembers,
    transport,
    providerName,
    termsUrl,
    maxAccountBytes = 1024 * 1024 * 1024,
    now = Date.now,
  }) {
    this.db = openDatabase(databasePath);
    this.privateKey = privateKey;
    this.gatewayId = publicHex(privateKey);
    this.indexServiceIds = new Set(indexServiceIds.map(hex));
    if (
      typeof storageAccountId !== "string" ||
      !/^[A-Za-z0-9._~-]{1,128}$/.test(storageAccountId) ||
      !Number.isSafeInteger(maxAccountBytes) ||
      maxAccountBytes < 16
    )
      fail("invalid-account-config");
    try {this.releaseOwnership=acquireGatewayOwnership({databasePath,transport,ownershipDirectory});}catch(e){this.db.close();throw e;}
    this.storageAccountId = storageAccountId;
    bindDatabaseIdentity(this.db, {
      schema: "castalia.files-gateway-database.v1",
      gatewayId: this.gatewayId,
      storageAccountId,
    });
    this.allowedMembers = new Set(allowedMembers.map(hex));
    this.transport = transport;
    this.providerName = providerName;
    this.termsUrl = termsUrl;
    this.maxAccountBytes = maxAccountBytes;
    this.now = now;
    this.serial = Promise.resolve();
    this.auth = new OwnerAuth(this.db, {
      serviceId: this.gatewayId,
      kind: "gateway",
      allowedOrigins,
      now,
    });
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS uploads(id TEXT PRIMARY KEY,owner TEXT NOT NULL,intent_digest TEXT NOT NULL,intent TEXT NOT NULL,object_key TEXT NOT NULL,upload_id TEXT,object_version TEXT,state TEXT NOT NULL,receipt TEXT); CREATE TABLE IF NOT EXISTS parts(upload_operation TEXT NOT NULL,part_number INTEGER NOT NULL,digest TEXT NOT NULL,byte_length INTEGER NOT NULL,etag TEXT NOT NULL,PRIMARY KEY(upload_operation,part_number));`,
    );
  }
  close() {
    try{this.db.close();}finally{this.releaseOwnership();}
  }
  config() {
    return {
      gatewayId: this.gatewayId,
      storageAccountId: this.storageAccountId,
      s3dRevision: S3D_REVISION,
      providerName: this.providerName,
      termsUrl: this.termsUrl,
    };
  }
  exclusive(fn) {
    const result = this.serial.then(fn);
    this.serial = result.catch(() => {});
    return result;
  }
  row(owner, id) {
    hex(id);
    const row = this.db
      .prepare("SELECT * FROM uploads WHERE id=? AND owner=?")
      .get(id, owner);
    if (!row) fail("not-found", undefined, 404);
    return row;
  }
  upload(owner, envelope) {
    return this.exclusive(async () => {
      if (!this.indexServiceIds.has(envelope?.keyId))
        fail("untrusted-index", undefined, 403);
      const p = parseUploadIntent(verifyEnvelope(envelope, envelope.keyId));
      if (
        !this.allowedMembers.has(owner) ||
        p.binding.ownerMemberKey !== owner ||
        p.binding.serviceId !== envelope.keyId ||
        p.binding.storageAccountId !== this.storageAccountId ||
        p.gatewayId !== this.gatewayId ||
        Date.parse(p.issuedAt) > this.now() + 30000 ||
        Date.parse(p.expiresAt) <= this.now()
      )
        fail("intent-denied", undefined, 403);
      const previous = this.db
        .prepare("SELECT * FROM uploads WHERE id=?")
        .get(p.operationId);
      if (previous) {
        if (
          previous.owner !== owner ||
          previous.intent_digest !== digest(envelope)
        )
          fail("operation-conflict", undefined, 409);
        if (!previous.upload_id) {
          const recovered = await this.transport.findMultipart(
            previous.object_key,
          );
          this.db
            .prepare("UPDATE uploads SET upload_id=?,state=? WHERE id=?")
            .run(recovered, "uploading", p.operationId);
        }
        return this.status(owner, p.operationId);
      }
      await this.transport.assertVersioning();
      const key = `castalia/${owner}/${p.operationId}/${p.ciphertextSha256}`;
      transaction(this.db,()=>{
        const reserved=this.db.prepare('SELECT intent FROM uploads').all().reduce((sum,row)=>sum+JSON.parse(row.intent).payload.byteLength,0);
        if(reserved+p.byteLength>this.maxAccountBytes)fail('storage-budget-exceeded',undefined,413);
        this.db.prepare('INSERT INTO uploads VALUES(?,?,?,?,?,NULL,NULL,?,NULL)').run(p.operationId,owner,digest(envelope),JSON.stringify(envelope),key,'initializing');
      });
      try {
        const uploadId = await this.transport.createMultipart(key, p);
        this.db
          .prepare("UPDATE uploads SET upload_id=?,state=? WHERE id=?")
          .run(uploadId, "uploading", p.operationId);
      } catch (e) {
        this.db
          .prepare("UPDATE uploads SET state=? WHERE id=?")
          .run("initialization-uncertain", p.operationId);
        throw e;
      }
      return this.status(owner, p.operationId);
    });
  }
  status(owner, id) {
    const r = this.row(owner, id);
    return {
      operationId: id,
      state: r.state,
      partBytes: UPLOAD_PART_BYTES,
      parts: this.db
        .prepare(
          "SELECT part_number AS partNumber,digest AS sha256,byte_length AS byteLength FROM parts WHERE upload_operation=? ORDER BY part_number",
        )
        .all(id),
      receipt: r.receipt ? JSON.parse(r.receipt) : null,
    };
  }
  putPart(owner, id, partNumber, bytes) {
    return this.exclusive(async () => {
      const r = this.row(owner, id),
        p = JSON.parse(r.intent).payload;
      if (!this.allowedMembers.has(owner))
        fail("account-admission-denied", undefined, 403);
      if (r.state !== "uploading" || Date.parse(p.expiresAt) <= this.now())
        fail("upload-not-writable", undefined, 409);
      const count = Math.ceil(p.byteLength / UPLOAD_PART_BYTES),
        expected =
          partNumber === count
            ? p.byteLength - UPLOAD_PART_BYTES * (count - 1)
            : UPLOAD_PART_BYTES;
      if (
        !Number.isSafeInteger(partNumber) ||
        partNumber < 1 ||
        partNumber > count ||
        bytes.byteLength !== expected
      )
        fail("invalid-part");
      const hash = digest(bytes),
        old = this.db
          .prepare(
            "SELECT * FROM parts WHERE upload_operation=? AND part_number=?",
          )
          .get(id, partNumber);
      if (old) {
        if (old.digest !== hash) fail("part-conflict", undefined, 409);
        return { partNumber, sha256: hash, byteLength: bytes.byteLength };
      }
      const etag = await this.transport.uploadPart(
        r.object_key,
        r.upload_id,
        partNumber,
        bytes,
      );
      this.db
        .prepare("INSERT INTO parts VALUES(?,?,?,?,?)")
        .run(id, partNumber, hash, bytes.byteLength, etag);
      return { partNumber, sha256: hash, byteLength: bytes.byteLength };
    });
  }
  complete(owner, id) {
    return this.exclusive(async () => {
      const r = this.row(owner, id),
        p = JSON.parse(r.intent).payload;
      if (r.receipt) return JSON.parse(r.receipt);
      if (!this.allowedMembers.has(owner))
        fail("account-admission-denied", undefined, 403);
      if (Date.parse(p.expiresAt) <= this.now())
        fail("intent-expired", undefined, 409);
      if (!r.upload_id)
        fail(
          "initialization-uncertain",
          "Multipart initiation needs operator reconciliation; no stored receipt exists",
          409,
        );
      const parts = this.db
        .prepare(
          "SELECT part_number AS partNumber,etag,byte_length AS byteLength FROM parts WHERE upload_operation=? ORDER BY part_number",
        )
        .all(id);
      if (
        parts.length !== Math.ceil(p.byteLength / UPLOAD_PART_BYTES) ||
        parts.reduce((n, v) => n + v.byteLength, 0) !== p.byteLength
      )
        fail("missing-parts", undefined, 409);
      let version = r.object_version;
      if (!version) {
        this.db
          .prepare("UPDATE uploads SET state=? WHERE id=?")
          .run("completion-uncertain", id);
        try {
          version = await this.transport.completeMultipart(
            r.object_key,
            r.upload_id,
            parts,
          );
        } catch (original) {
          try {
            const head = await this.transport.head(r.object_key);
            if (
              head.operationId !== id ||
              head.ciphertextSha256 !== p.ciphertextSha256 ||
              head.byteLength !== p.byteLength
            )
              throw original;
            version = head.version;
          } catch {
            throw original;
          }
        }
        this.db
          .prepare("UPDATE uploads SET object_version=?,state=? WHERE id=?")
          .run(version, "verifying", id);
      }
      await this.transport.flush();
      const stats = await this.transport.stats();
      if (stats.pendingObjects !== 0 || stats.unpinnedObjects !== 0)
        fail(
          "storage-not-durable",
          "s3d still has pending or unpinned objects",
          409,
        );
      const hash = createHash("sha256");
      let size = 0;
      const stream = await this.transport.get(r.object_key, version);
      for await (const bytes of stream) {
        size += bytes.length;
        if (size > p.byteLength) {
          await stream.cancel?.().catch(() => {});
          fail("stored-size-mismatch", undefined, 502);
        }
        hash.update(bytes);
      }
      if (size !== p.byteLength || hash.digest("hex") !== p.ciphertextSha256)
        fail("stored-integrity-mismatch", undefined, 502);
      const payload = parseStorageReceipt({
        schema: "castalia.files-storage-receipt.v1",
        operationId: id,
        ownerMemberKey: owner,
        storageAccountId: this.storageAccountId,
        gatewayId: this.gatewayId,
        objectKey: r.object_key,
        objectVersion: version,
        ciphertextSha256: p.ciphertextSha256,
        byteLength: p.byteLength,
        s3dRevision: S3D_REVISION,
        pendingObjects: 0,
        unpinnedObjects: 0,
        verifiedAt: new Date(this.now()).toISOString(),
      });
      const receipt = signEnvelope(payload, this.privateKey);
      this.db
        .prepare("UPDATE uploads SET state=?,receipt=? WHERE id=?")
        .run("stored", JSON.stringify(receipt), id);
      return receipt;
    });
  }
  async download(owner, id) {
    const r = this.row(owner, id);
    if (!r.receipt || !r.object_version) fail("not-stored", undefined, 409);
    return {
      stream: await this.transport.get(r.object_key, r.object_version),
      receipt: JSON.parse(r.receipt),
    };
  }
}
