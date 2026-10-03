// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  verifyRegistrationChain,
  verifiedRegistrationState,
  PERSON_CLASS,
  ORGANIZATION_CLASS,
} from "../../packages/browser/src/registration.mjs";
import {
  parseFilesKeyBinding,
  parseFilesKeyEnvelope,
  canonicalJson,
  decodeBase64url,
} from "../../packages/browser/src/shipping-contract.mjs";
import {
  parseUploadIntent,
  parseStorageReceipt,
  parseIndexAcceptance,
  parseNamespaceAcceptance,
  MAX_SHIPMENT_BYTES,
} from "../../packages/browser/src/shipping-receipts.mjs";
import {
  openDatabase,
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
  origin,
} from "./common.mjs";
const read = (row) => (row ? JSON.parse(row.value) : null);
export class FilesIndex {
  constructor({
    databasePath,
    privateKey,
    allowedOrigins,
    trustPolicy,
    gateways,
    canonicalBindings = [],
    now = Date.now,
  }) {
    this.db = openDatabase(databasePath);
    this.privateKey = privateKey;
    this.serviceId = publicHex(privateKey);
    this.now = now;
    bindDatabaseIdentity(this.db, {
      schema: "castalia.files-index-database.v1",
      serviceId: this.serviceId,
    });
    this.trustPolicy = trustPolicy;
    this.gateways = new Map(gateways.map((v) => [hex(v.gatewayId), v]));
    this.canonicalBindings = canonicalBindings;
    this.auth = new OwnerAuth(this.db, {
      serviceId: this.serviceId,
      kind: "index",
      allowedOrigins,
      now,
    });
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS namespaces(id TEXT PRIMARY KEY,creator TEXT NOT NULL,kind TEXT NOT NULL,controller TEXT NOT NULL,genesis TEXT NOT NULL,current_digest TEXT NOT NULL,value TEXT NOT NULL); CREATE UNIQUE INDEX IF NOT EXISTS one_personal ON namespaces(creator) WHERE kind='person'; CREATE TABLE IF NOT EXISTS grants(namespace_id TEXT NOT NULL,grantee TEXT NOT NULL,controller TEXT NOT NULL,current_digest TEXT NOT NULL,value TEXT NOT NULL,PRIMARY KEY(namespace_id,grantee)); CREATE TABLE IF NOT EXISTS operations(id TEXT PRIMARY KEY,owner TEXT NOT NULL,request_digest TEXT NOT NULL,intent TEXT NOT NULL,result TEXT); CREATE TABLE IF NOT EXISTS submissions(id TEXT PRIMARY KEY,owner TEXT NOT NULL,namespace_id TEXT NOT NULL,workspace_id TEXT NOT NULL,head TEXT NOT NULL,sequence INTEGER NOT NULL,withdrawn INTEGER NOT NULL DEFAULT 0); CREATE TABLE IF NOT EXISTS revisions(id TEXT PRIMARY KEY,submission_id TEXT NOT NULL,owner TEXT NOT NULL,value TEXT NOT NULL); CREATE TABLE IF NOT EXISTS connections(owner TEXT NOT NULL,gateway_id TEXT NOT NULL,account_id TEXT NOT NULL,value TEXT NOT NULL,PRIMARY KEY(owner,gateway_id,account_id));`,
    );
  }
  close() {
    this.db.close();
  }
  config() {
    return { serviceId: this.serviceId };
  }
  async acceptRegistration(owner, input) {
    exact(input, ["chain", "membershipCredential", "expectedManifestDigest"]);
    const checked = await verifyRegistrationChain(input.chain, {
        membershipCredential: input.membershipCredential,
        trustPolicy: this.trustPolicy,
      }),
      state = verifiedRegistrationState(checked),
      m = state.manifest;
    if (
      ![
        m.creatorMemberKey,
        m.controllerMemberKey,
        state.chain.at(-1).signerMemberKey,
      ].includes(owner)
    )
      fail("registration-owner-denied", undefined, 403);
    if (
      m.entityClass === PERSON_CLASS &&
      m.controllerMemberKey !== m.creatorMemberKey
    )
      fail("personal-controller-mismatch", undefined, 403);
    return transaction(this.db, () => {
      const old = this.db
        .prepare("SELECT * FROM namespaces WHERE id=?")
        .get(m.namespaceId);
      if (old?.current_digest === state.manifestDigest)
        return this.namespaceResponse(JSON.parse(old.value));
      if ((old?.current_digest ?? null) !== input.expectedManifestDigest)
        fail("registration-conflict", undefined, 409);
      if (old) {
        const prior = JSON.parse(old.value);
        if (
          state.genesisDigest !== old.genesis ||
          state.chain.length <= prior.chain.length ||
          canonicalJson(state.chain.slice(0, prior.chain.length)) !==
            canonicalJson(prior.chain)
        )
          fail("registration-fork", undefined, 409);
        if (state.chain[prior.chain.length].signerMemberKey !== old.controller)
          fail("controller-denied", undefined, 403);
      } else if (state.chain.length !== 1 || owner !== m.creatorMemberKey)
        fail("genesis-required", undefined, 403);
      const value = {
        chain: state.chain,
        membershipCredential: state.membershipCredential,
        manifest: m,
        manifestDigest: state.manifestDigest,
        genesisDigest: state.genesisDigest,
      };
      this.db
        .prepare(
          "INSERT INTO namespaces VALUES(?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET controller=excluded.controller,current_digest=excluded.current_digest,value=excluded.value",
        )
        .run(
          m.namespaceId,
          m.creatorMemberKey,
          m.entityClass === PERSON_CLASS ? "person" : "organization",
          m.controllerMemberKey,
          state.genesisDigest,
          state.manifestDigest,
          JSON.stringify(value),
        );
      return this.namespaceResponse(value);
    });
  }
  namespaceResponse(value) {
    if (!value) return null;
    const m = value.manifest;
    return {
      registration: {
        chain: value.chain,
        membershipCredential: value.membershipCredential,
      },
      receipt: signEnvelope(
        parseNamespaceAcceptance({
          schema: "castalia.files-namespace-acceptance.v1",
          serviceId: this.serviceId,
          manifestDigest: value.manifestDigest,
          registrationGenesisDigest: value.genesisDigest,
          namespaceId: m.namespaceId,
          workspaceId: m.initialWorkspaceId,
          entityRef: m.entityRef,
          controllerMemberKey: m.controllerMemberKey,
          acceptedAt: new Date(this.now()).toISOString(),
        }),
        this.privateKey,
      ),
    };
  }
  personal(owner) {
    return this.namespaceResponse(
      read(
        this.db
          .prepare(
            "SELECT value FROM namespaces WHERE creator=? AND kind='person'",
          )
          .get(owner),
      ),
    );
  }
  namespaces(owner) {
    return this.db
      .prepare("SELECT * FROM namespaces ORDER BY id")
      .all()
      .filter((row) =>
        this.canAdmit(
          owner,
          row,
          JSON.parse(row.value).manifest.initialWorkspaceId,
          0,
        ),
      )
      .map((row) => this.namespaceResponse(JSON.parse(row.value)));
  }
  destinations(owner) {
    const personal = this.personal(owner);
    const binding = this.canonicalBindings.find((v) => v.alias === "zenith");
    const row = binding
      ? this.db
          .prepare(
            "SELECT * FROM namespaces WHERE id=? AND kind='organization' AND genesis=?",
          )
          .get(binding.namespaceId, binding.registrationGenesisDigest)
      : null;
    return {
      personal,
      zenith: row
        ? {
            state: "registered",
            namespaceId: row.id,
            registrationGenesisDigest: row.genesis,
            canSubmit: this.canAdmit(
              owner,
              row,
              JSON.parse(row.value).manifest.initialWorkspaceId,
              0,
            ),
          }
        : {
            state: "pending",
            reason:
              "Organization registration and canonical binding have not been accepted",
          },
    };
  }
  setGrant(owner, input) {
    exact(input, [
      "namespaceId",
      "granteeMemberKey",
      "workspaceId",
      "actions",
      "maxBytes",
      "expiresAt",
    ]);
    hex(input.namespaceId);
    hex(input.granteeMemberKey);
    if (input.workspaceId !== null) hex(input.workspaceId);
    if (
      !Array.isArray(input.actions) ||
      !input.actions.length ||
      new Set(input.actions).size !== input.actions.length ||
      input.actions.some(
        (v) => !["submit", "update-own", "withdraw-own"].includes(v),
      ) ||
      !Number.isSafeInteger(input.maxBytes) ||
      input.maxBytes < 16 ||
      input.maxBytes > MAX_SHIPMENT_BYTES ||
      !Number.isFinite(Date.parse(input.expiresAt)) ||
      Date.parse(input.expiresAt) <= this.now() ||
      Date.parse(input.expiresAt) > this.now() + 30 * 86400000
    )
      fail("invalid-grant");
    return transaction(this.db, () => {
      const row = this.db
        .prepare("SELECT * FROM namespaces WHERE id=?")
        .get(input.namespaceId);
      if (!row || row.kind !== "organization" || row.controller !== owner)
        fail("controller-denied", undefined, 403);
      const acceptance = signEnvelope(
        {
          schema: "castalia.files-admission-grant.v1",
          serviceId: this.serviceId,
          namespaceId: row.id,
          registrationGenesisDigest: row.genesis,
          manifestDigest: row.current_digest,
          issuerControllerMemberKey: owner,
          granteeMemberKey: input.granteeMemberKey,
          workspaceId: input.workspaceId,
          actions: [...input.actions].sort(),
          maxBytes: input.maxBytes,
          issuedAt: new Date(this.now()).toISOString(),
          expiresAt: new Date(input.expiresAt).toISOString(),
        },
        this.privateKey,
      );
      this.db
        .prepare(
          "INSERT INTO grants VALUES(?,?,?,?,?) ON CONFLICT(namespace_id,grantee) DO UPDATE SET controller=excluded.controller,current_digest=excluded.current_digest,value=excluded.value",
        )
        .run(
          row.id,
          input.granteeMemberKey,
          owner,
          row.current_digest,
          JSON.stringify({ grant: input, acceptance }),
        );
      return acceptance;
    });
  }
  revokeGrant(owner, input) {
    exact(input, ["namespaceId", "granteeMemberKey"]);
    const { namespaceId, granteeMemberKey } = input;
    hex(namespaceId);
    hex(granteeMemberKey);
    return transaction(this.db, () => {
      const row = this.db
        .prepare("SELECT * FROM namespaces WHERE id=?")
        .get(namespaceId);
      if (!row || row.controller !== owner)
        fail("controller-denied", undefined, 403);
      this.db
        .prepare("DELETE FROM grants WHERE namespace_id=? AND grantee=?")
        .run(namespaceId, granteeMemberKey);
      return { revoked: true };
    });
  }
  canAdmit(owner, row, workspace, bytes, action = "submit") {
    if (row.kind === "person")
      return row.creator === owner && row.controller === owner;
    const canonical = this.canonicalBindings.find((v) => v.alias === "zenith");
    if (
      !canonical ||
      row.id !== canonical.namespaceId ||
      row.genesis !== canonical.registrationGenesisDigest
    )
      return false;
    if (row.controller === owner) return true;
    const grant = this.db
      .prepare("SELECT * FROM grants WHERE namespace_id=? AND grantee=?")
      .get(row.id, owner);
    if (
      !grant ||
      grant.controller !== row.controller ||
      grant.current_digest !== row.current_digest
    )
      return false;
    const v = JSON.parse(grant.value).grant;
    return (
      Date.parse(v.expiresAt) > this.now() &&
      v.actions.includes(action) &&
      (v.workspaceId === null || v.workspaceId === workspace) &&
      bytes <= v.maxBytes
    );
  }
  admission(owner, binding, bytes, expected) {
    const row = this.db
      .prepare("SELECT * FROM namespaces WHERE id=?")
      .get(binding.namespaceId);
    if (
      !row ||
      !this.canAdmit(
        owner,
        row,
        binding.workspaceId,
        bytes,
        expected === null ? "submit" : "update-own",
      )
    )
      fail("namespace-admission-denied", undefined, 403);
    return row;
  }
  createIntent(owner, input) {
    exact(input, [
      "operationId",
      "binding",
      "expectedRevisionId",
      "ciphertextSha256",
      "byteLength",
      "gatewayId",
    ]);
    const binding = parseFilesKeyBinding(input.binding);
    hex(input.operationId);
    hex(input.ciphertextSha256);
    hex(input.gatewayId);
    if (input.expectedRevisionId !== null) hex(input.expectedRevisionId);
    if (
      binding.ownerMemberKey !== owner ||
      binding.serviceId !== this.serviceId
    )
      fail("binding-owner-service-mismatch", undefined, 403);
    const gateway = this.gateways.get(input.gatewayId);
    if (
      !gateway ||
      !gateway.allowedMembers?.includes(owner) ||
      gateway.storageAccountId !== binding.storageAccountId
    )
      fail("untrusted-gateway", undefined, 403);
    const requestDigest = digest(input);
    return transaction(this.db, () => {
      const previous = this.db
        .prepare("SELECT * FROM operations WHERE id=?")
        .get(input.operationId);
      if (previous) {
        if (
          previous.owner !== owner ||
          previous.request_digest !== requestDigest
        )
          fail("operation-conflict", undefined, 409);
        return JSON.parse(previous.intent);
      }
      const connection = read(
        this.db
          .prepare(
            "SELECT value FROM connections WHERE owner=? AND gateway_id=? AND account_id=?",
          )
          .get(owner, input.gatewayId, binding.storageAccountId),
      );
      if (connection) {
        const reserved = this.db
          .prepare("SELECT intent FROM operations WHERE owner=?")
          .all(owner)
          .reduce((sum, row) => {
            const p = JSON.parse(row.intent).payload;
            return (
              sum +
              (p.binding.storageAccountId === binding.storageAccountId &&
              p.gatewayId === input.gatewayId
                ? p.byteLength
                : 0)
            );
          }, 0);
        if (reserved + input.byteLength > connection.budgetBytes)
          fail("owner-storage-budget-exceeded", undefined, 413);
      }
      const row = this.admission(
        owner,
        binding,
        input.byteLength,
        input.expectedRevisionId,
      );
      this.assertHead(owner, binding, input.expectedRevisionId);
      const time = this.now();
      const payload = parseUploadIntent({
        schema: "castalia.files-upload-intent.v1",
        operationId: input.operationId,
        binding,
        registrationGenesisDigest: row.genesis,
        expectedRevisionId: input.expectedRevisionId,
        ciphertextSha256: input.ciphertextSha256,
        byteLength: input.byteLength,
        gatewayId: input.gatewayId,
        issuedAt: new Date(time).toISOString(),
        expiresAt: new Date(time + 86400000).toISOString(),
      });
      const signed = signEnvelope(payload, this.privateKey);
      this.db
        .prepare("INSERT INTO operations VALUES(?,?,?,?,NULL)")
        .run(input.operationId, owner, requestDigest, JSON.stringify(signed));
      return signed;
    });
  }
  assertHead(owner, binding, expected) {
    const old = this.db
      .prepare("SELECT * FROM submissions WHERE id=?")
      .get(binding.submissionId);
    if (
      old &&
      (old.owner !== owner ||
        old.namespace_id !== binding.namespaceId ||
        old.workspace_id !== binding.workspaceId)
    )
      fail("submission-owner-or-placement-mismatch", undefined, 403);
    if ((old?.head ?? null) !== expected || old?.withdrawn)
      fail("head-conflict", undefined, 409);
    return old;
  }
  commit(owner, input) {
    exact(input, [
      "operationId",
      "storageReceipt",
      "descriptorDigest",
      "keyEnvelope",
      "nonce",
    ]);
    hex(input.operationId);
    hex(input.descriptorDigest);
    const keyEnvelope = parseFilesKeyEnvelope(input.keyEnvelope);
    decodeBase64url(input.nonce, 12);
    return transaction(this.db, () => {
      const op = this.db
        .prepare("SELECT * FROM operations WHERE id=? AND owner=?")
        .get(input.operationId, owner);
      if (!op) fail("unknown-operation", undefined, 404);
      const intent = parseUploadIntent(JSON.parse(op.intent).payload),
        b = intent.binding;
      const commitDigest = digest(input);
      if (op.result) {
        const prior = JSON.parse(op.result);
        if (prior.commitDigest !== commitDigest)
          fail("operation-conflict", undefined, 409);
        return prior.acceptance;
      }
      if (Date.parse(intent.expiresAt) <= this.now())
        fail("intent-expired", undefined, 409);
      const gateway = this.gateways.get(intent.gatewayId);
      const r = parseStorageReceipt(
        verifyEnvelope(input.storageReceipt, gateway.gatewayId),
      );
      if (
        r.operationId !== intent.operationId ||
        r.ownerMemberKey !== owner ||
        r.storageAccountId !== b.storageAccountId ||
        r.gatewayId !== intent.gatewayId ||
        r.ciphertextSha256 !== intent.ciphertextSha256 ||
        r.byteLength !== intent.byteLength ||
        input.descriptorDigest !==
          digest({
            binding: b,
            keyEnvelope,
            nonce: input.nonce,
            ciphertextSha256: intent.ciphertextSha256,
          }) ||
        canonicalJson(keyEnvelope.binding) !== canonicalJson(b) ||
        Date.parse(r.verifiedAt) < Date.parse(intent.issuedAt) ||
        Date.parse(r.verifiedAt) > this.now() + 30000
      )
        fail("storage-binding-mismatch", undefined, 403);
      const row = this.admission(
        owner,
        b,
        intent.byteLength,
        intent.expectedRevisionId,
      );
      if (row.genesis !== intent.registrationGenesisDigest)
        fail("registration-conflict", undefined, 409);
      const old = this.assertHead(owner, b, intent.expectedRevisionId),
        sequence = (old?.sequence ?? 0) + 1;
      const payload = parseIndexAcceptance({
        schema: "castalia.files-index-acceptance.v1",
        operationId: input.operationId,
        ownerMemberKey: owner,
        serviceId: this.serviceId,
        namespaceId: b.namespaceId,
        workspaceId: b.workspaceId,
        registrationGenesisDigest: row.genesis,
        submissionId: b.submissionId,
        revisionId: b.revisionId,
        previousRevisionId: intent.expectedRevisionId,
        descriptorDigest: input.descriptorDigest,
        storageReceiptDigest: digest(input.storageReceipt),
        sequence,
        acceptedAt: new Date(this.now()).toISOString(),
      });
      const acceptance = signEnvelope(payload, this.privateKey);
      const value = {
        acceptance,
        keyEnvelope,
        nonce: input.nonce,
        storageReceipt: input.storageReceipt,
      };
      if (
        this.db.prepare("SELECT 1 FROM revisions WHERE id=?").get(b.revisionId)
      )
        fail("revision-reuse", undefined, 409);
      this.db
        .prepare("INSERT INTO revisions VALUES(?,?,?,?)")
        .run(b.revisionId, b.submissionId, owner, JSON.stringify(value));
      this.db
        .prepare(
          "INSERT INTO submissions VALUES(?,?,?,?,?,?,0) ON CONFLICT(id) DO UPDATE SET head=excluded.head,sequence=excluded.sequence",
        )
        .run(
          b.submissionId,
          owner,
          b.namespaceId,
          b.workspaceId,
          b.revisionId,
          sequence,
        );
      this.db
        .prepare("UPDATE operations SET result=? WHERE id=?")
        .run(JSON.stringify({ commitDigest, acceptance }), input.operationId);
      return acceptance;
    });
  }
  operation(owner, id) {
    hex(id);
    const row = this.db
      .prepare("SELECT * FROM operations WHERE id=? AND owner=?")
      .get(id, owner);
    if (!row) fail("not-found", undefined, 404);
    return {
      intent: JSON.parse(row.intent),
      acceptance: row.result ? JSON.parse(row.result).acceptance : null,
    };
  }
  inventory(owner) {
    return this.db
      .prepare("SELECT * FROM submissions WHERE owner=? ORDER BY id")
      .all(owner)
      .map((row) => ({
        submissionId: row.id,
        namespaceId: row.namespace_id,
        workspaceId: row.workspace_id,
        head: row.head,
        sequence: row.sequence,
        withdrawn: Boolean(row.withdrawn),
        ...read(
          this.db
            .prepare("SELECT value FROM revisions WHERE id=? AND owner=?")
            .get(row.head, owner),
        ),
      }));
  }
  revision(owner, id, revisionId) {
    hex(id);
    hex(revisionId);
    const row = this.db
      .prepare(
        "SELECT value FROM revisions WHERE submission_id=? AND id=? AND owner=?",
      )
      .get(id, revisionId, owner);
    if (!row) fail("not-found", undefined, 404);
    return read(row);
  }
  history(owner, id) {
    hex(id);
    const row = this.db
      .prepare("SELECT * FROM submissions WHERE id=? AND owner=?")
      .get(id, owner);
    if (!row) fail("not-found", undefined, 404);
    return {
      withdrawn: Boolean(row.withdrawn),
      revisions: this.db
        .prepare(
          "SELECT value FROM revisions WHERE submission_id=? AND owner=? ORDER BY rowid",
        )
        .all(id, owner)
        .map(read),
    };
  }
  withdraw(owner, input) {
    exact(input, ["submissionId", "expectedRevisionId"]);
    hex(input.submissionId);
    hex(input.expectedRevisionId);
    return transaction(this.db, () => {
      const row = this.db
        .prepare("SELECT * FROM submissions WHERE id=? AND owner=?")
        .get(input.submissionId, owner);
      if (!row) fail("not-found", undefined, 404);
      if (row.head !== input.expectedRevisionId)
        fail("head-conflict", undefined, 409);
      this.db
        .prepare("UPDATE submissions SET withdrawn=1 WHERE id=?")
        .run(row.id);
      return {
        withdrawn: true,
        submissionId: row.id,
        head: row.head,
        remoteDeletion: false,
      };
    });
  }
  connections(owner) {
    return this.db
      .prepare(
        "SELECT value FROM connections WHERE owner=? ORDER BY gateway_id,account_id",
      )
      .all(owner)
      .map(read);
  }
  saveConnection(owner, input) {
    exact(input, [
      "gatewayUrl",
      "gatewayId",
      "storageAccountId",
      "providerName",
      "termsUrl",
      "budgetBytes",
    ]);
    const u = new URL(input.gatewayUrl);
    origin(u.origin);
    if (u.username || u.password || u.search || u.hash || u.pathname !== "/")
      fail("invalid-gateway-url");
    const g = this.gateways.get(hex(input.gatewayId));
    if (
      !g ||
      !g.allowedMembers?.includes(owner) ||
      g.storageAccountId !== input.storageAccountId ||
      new URL(g.gatewayUrl).origin !== u.origin
    )
      fail("untrusted-gateway", undefined, 403);
    if (
      typeof input.providerName !== "string" ||
      input.providerName.length > 128 ||
      typeof input.termsUrl !== "string" ||
      new URL(input.termsUrl).protocol !== "https:" ||
      !Number.isSafeInteger(input.budgetBytes) ||
      input.budgetBytes < 0
    )
      fail("invalid-connection");
    this.db
      .prepare(
        "INSERT INTO connections VALUES(?,?,?,?) ON CONFLICT(owner,gateway_id,account_id) DO UPDATE SET value=excluded.value",
      )
      .run(
        owner,
        input.gatewayId,
        input.storageAccountId,
        JSON.stringify({ ...input, gatewayUrl: u.origin }),
      );
    return { ...input, gatewayUrl: u.origin };
  }
}
