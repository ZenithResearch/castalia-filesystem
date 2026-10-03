// SPDX-License-Identifier: AGPL-3.0-or-later
import { DatabaseSync, backup } from "node:sqlite";
import {
  mkdirSync,
  lstatSync,
  chmodSync,
  existsSync,
  openSync,
  closeSync,
  fsyncSync,
  writeFileSync,
  readFileSync,
  unlinkSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import {
  createHash,
  createPublicKey,
  sign,
  verify,
  randomBytes,
} from "node:crypto";
import {
  canonicalJson,
  authChallengeBytes,
} from "../../packages/browser/src/shipping-contract.mjs";
export class ServiceError extends Error {
  constructor(code, message = code, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}
export const fail = (code, message, status) => {
  throw new ServiceError(code, message, status);
};
export function exact(v, fields) {
  if (
    !v ||
    typeof v !== "object" ||
    Array.isArray(v) ||
    Object.keys(v).sort().join("\0") !== [...fields].sort().join("\0")
  )
    fail("invalid-shape");
}
export function hex(v) {
  if (typeof v !== "string" || !/^[0-9a-f]{64}$/.test(v)) fail("invalid-id");
  return v;
}
export const digest = (value) =>
  createHash("sha256")
    .update(
      typeof value === "string" || value instanceof Uint8Array
        ? value
        : canonicalJson(value),
    )
    .digest("hex");
export const randomId = () => randomBytes(32).toString("hex");
export function origin(v) {
  let u;
  try {
    u = new URL(v);
  } catch {
    fail("invalid-origin");
  }
  if (
    u.origin !== v ||
    !(
      u.protocol === "https:" ||
      (u.protocol === "http:" &&
        ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname))
    )
  )
    fail("invalid-origin");
  return v;
}
export function publicHex(key) {
  const k = createPublicKey(key);
  if (k.asymmetricKeyType !== "ed25519") fail("wrong-key-type");
  return k
    .export({ format: "der", type: "spki" })
    .subarray(-32)
    .toString("hex");
}
export function signEnvelope(payload, privateKey) {
  return {
    payload,
    keyId: publicHex(privateKey),
    signature: sign(
      null,
      Buffer.from(canonicalJson(payload)),
      privateKey,
    ).toString("base64url"),
  };
}
export function verifyEnvelope(input, publicKey) {
  exact(input, ["payload", "keyId", "signature"]);
  if (
    input.keyId !== hex(publicKey) ||
    typeof input.signature !== "string" ||
    !/^[A-Za-z0-9_-]{86}$/.test(input.signature)
  )
    fail("untrusted-receipt", undefined, 403);
  const signature = Buffer.from(input.signature, "base64url");
  if (
    signature.toString("base64url") !== input.signature ||
    !verify(
      null,
      Buffer.from(canonicalJson(input.payload)),
      createPublicKey({
        key: Buffer.from("302a300506032b6570032100" + publicKey, "hex"),
        format: "der",
        type: "spki",
      }),
      signature,
    )
  )
    fail("invalid-signature", undefined, 403);
  return input.payload;
}
export function openDatabase(path) {
  if (path !== ":memory:") {
    const dir = dirname(resolve(path));
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const ds = lstatSync(dir);
    if (!ds.isDirectory() || ds.isSymbolicLink() || ds.mode & 0o077)
      fail("unsafe-database-directory");
    for (const suffix of ["", "-wal", "-shm"])
      if (existsSync(path + suffix)) {
        const s = lstatSync(path + suffix);
        if (
          !s.isFile() ||
          s.isSymbolicLink() ||
          s.nlink !== 1 ||
          s.mode & 0o077
        )
          fail("unsafe-database-file");
      }
  }
  const db = new DatabaseSync(path);
  if (path !== ":memory:") chmodSync(path, 0o600);
  db.exec(
    "PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;",
  );
  return db;
}
export async function backupDatabase(db, destination) {
  const dir = dirname(resolve(destination));
  const stat = lstatSync(dir);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.mode & 0o077)
    fail("unsafe-backup-directory");
  const fd = openSync(destination, "wx", 0o600);
  closeSync(fd);
  await backup(db, destination);
  const output = openSync(destination, "r");
  try {
    fsyncSync(output);
  } finally {
    closeSync(output);
  }
  const directory = openSync(dir, "r");
  try {
    fsyncSync(directory);
  } finally {
    closeSync(directory);
  }
}
export function acquireGatewayOwnership({databasePath,transport,ownershipDirectory}) {
  const live=typeof transport.endpoint==='string'&&typeof transport.bucket==='string';
  if(live&&typeof ownershipDirectory!=='string')fail('gateway-ownership-directory-required');
  const directory=live?resolve(ownershipDirectory):dirname(resolve(databasePath));
  mkdirSync(directory,{recursive:true,mode:0o700});const stat=lstatSync(directory);
  if(!stat.isDirectory()||stat.isSymbolicLink()||(stat.mode&0o077)||(typeof process.getuid==='function'&&stat.uid!==process.getuid()))fail('unsafe-ownership-directory');
  const connection=live?{endpoint:new URL(transport.endpoint).origin,bucket:transport.bucket}:{database:resolve(databasePath)};
  const path=resolve(directory,'gateway-'+digest(connection)+'.lock'),token=randomId();
  let fd;try{fd=openSync(path,'wx',0o600);}catch(e){if(e.code==='EEXIST')fail('gateway-already-owned','Existing gateway ownership lock; recover a stale lock manually after confirming no process uses this account',409);throw e;}
  try{writeFileSync(fd,JSON.stringify({schema:'castalia.gateway-process-lock.v1',pid:process.pid,token,database:resolve(databasePath)}));fsyncSync(fd);}finally{closeSync(fd);}
  const parent=openSync(directory,'r');try{fsyncSync(parent);}finally{closeSync(parent);}
  return ()=>{try{const record=JSON.parse(readFileSync(path,'utf8'));if(record.token===token)unlinkSync(path);}catch(e){if(e.code!=='ENOENT')throw e;}};
}
export function bindDatabaseIdentity(db, identity) {
  db.exec(
    "CREATE TABLE IF NOT EXISTS service_identity (singleton INTEGER PRIMARY KEY CHECK(singleton=1), value TEXT NOT NULL)",
  );
  const expected = canonicalJson(identity);
  transaction(db, () => {
    const old = db
      .prepare("SELECT value FROM service_identity WHERE singleton=1")
      .get();
    if (old && old.value !== expected) fail("database-identity-mismatch");
    if (!old)
      db.prepare("INSERT INTO service_identity VALUES(1,?)").run(expected);
  });
}
export function transaction(db, fn) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const value = fn();
    if (value?.then) fail("async-transaction");
    db.exec("COMMIT");
    return value;
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}
export class OwnerAuth {
  constructor(db, { serviceId, kind, allowedOrigins, now = Date.now }) {
    this.db = db;
    this.serviceId = hex(serviceId);
    this.audience = `castalia-files://${kind}/${serviceId}`;
    this.origins = new Set(allowedOrigins.map(origin));
    this.now = now;
    db.exec(
      `CREATE TABLE IF NOT EXISTS auth_challenges(nonce TEXT PRIMARY KEY,owner TEXT NOT NULL,origin TEXT NOT NULL,challenge TEXT NOT NULL,expires INTEGER NOT NULL,consumed INTEGER NOT NULL DEFAULT 0); CREATE TABLE IF NOT EXISTS auth_sessions(token_hash TEXT PRIMARY KEY,owner TEXT NOT NULL,origin TEXT NOT NULL,expires INTEGER NOT NULL);`,
    );
  }
  checkOrigin(value) {
    if (!this.origins.has(origin(value))) fail("origin-denied", undefined, 403);
  }
  challenge(memberKey, requestOrigin) {
    this.checkOrigin(requestOrigin);
    hex(memberKey);
    const now = this.now();
    this.db.prepare("DELETE FROM auth_challenges WHERE expires < ?").run(now);
    this.db.prepare("DELETE FROM auth_sessions WHERE expires < ?").run(now);
    if (
      this.db.prepare("SELECT COUNT(*) AS n FROM auth_challenges").get().n >=
        10000 ||
      this.db
        .prepare(
          "SELECT COUNT(*) AS n FROM auth_challenges WHERE owner=? AND consumed=0",
        )
        .get(memberKey).n >= 16
    )
      fail("challenge-limit", undefined, 429);
    const value = {
      audience: this.audience,
      domain: "castalia-wallet",
      expiresAt: new Date(now + 120000).toISOString(),
      issuedAt: new Date(now).toISOString(),
      nonce: randomId(),
      operation: "castalia.wallet.signChallenge",
      origin: requestOrigin,
      version: 1,
    };
    this.db
      .prepare(
        "INSERT INTO auth_challenges(nonce,owner,origin,challenge,expires) VALUES(?,?,?,?,?)",
      )
      .run(
        value.nonce,
        memberKey,
        requestOrigin,
        JSON.stringify(value),
        now + 120000,
      );
    return value;
  }
  login(presentation, requestOrigin) {
    this.checkOrigin(requestOrigin);
    exact(presentation, [
      "subject",
      "challenge",
      "signature",
      "signatureAlgorithm",
    ]);
    const row = this.db
      .prepare("SELECT * FROM auth_challenges WHERE nonce=?")
      .get(presentation.challenge?.nonce ?? "");
    if (
      !row ||
      row.consumed ||
      row.expires <= this.now() ||
      row.origin !== requestOrigin
    )
      fail("challenge-expired-or-used", undefined, 401);
    const expected = JSON.parse(row.challenge);
    if (canonicalJson(presentation.challenge) !== canonicalJson(expected))
      fail("challenge-mismatch", undefined, 401);
    const subject = presentation.subject;
    if (
      !subject ||
      subject.subjectId !== `did:castalia:member:${row.owner}` ||
      !["ed25519", "node-ed25519"].includes(presentation.signatureAlgorithm)
    )
      fail("subject-mismatch", undefined, 401);
    let key;
    try {
      key = createPublicKey(subject.publicKey);
    } catch {
      fail("invalid-public-key", undefined, 401);
    }
    if (
      key.asymmetricKeyType !== "ed25519" ||
      key
        .export({ format: "der", type: "spki" })
        .subarray(-32)
        .toString("hex") !== row.owner
    )
      fail("subject-mismatch", undefined, 401);
    const sig = Buffer.from(
      typeof presentation.signature === "string" ? presentation.signature : "",
      "base64",
    );
    if (
      sig.length !== 64 ||
      sig.toString("base64") !== presentation.signature ||
      !verify(null, authChallengeBytes(expected), key, sig)
    )
      fail("invalid-signature", undefined, 401);
    const token = randomBytes(32).toString("base64url"),
      expires = this.now() + 900000;
    transaction(this.db, () => {
      if (
        this.db
          .prepare(
            "UPDATE auth_challenges SET consumed=1 WHERE nonce=? AND consumed=0 AND expires>?",
          )
          .run(expected.nonce, this.now()).changes !== 1
      )
        fail("challenge-expired-or-used", undefined, 401);
      this.db
        .prepare("INSERT INTO auth_sessions VALUES(?,?,?,?)")
        .run(digest(token), row.owner, requestOrigin, expires);
    });
    return {
      token,
      memberKey: row.owner,
      expiresAt: new Date(expires).toISOString(),
    };
  }
  owner(token, requestOrigin) {
    this.checkOrigin(requestOrigin);
    if (typeof token !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(token))
      fail("unauthenticated", undefined, 401);
    const row = this.db
      .prepare("SELECT * FROM auth_sessions WHERE token_hash=?")
      .get(digest(token));
    if (!row || row.origin !== requestOrigin || row.expires <= this.now())
      fail("session-expired-or-denied", undefined, 401);
    return row.owner;
  }
  logout(token, requestOrigin) {
    this.owner(token, requestOrigin);
    this.db
      .prepare("DELETE FROM auth_sessions WHERE token_hash=?")
      .run(digest(token));
  }
}
