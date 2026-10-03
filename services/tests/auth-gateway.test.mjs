import test from "node:test";
import assert from "node:assert/strict";
import { FilesGateway } from "../src/gateway.mjs";
import {
  fixture,
  register,
  intent,
  stored,
  owner,
  other,
  id,
  presentation,
  appOrigin,
} from "./helpers.mjs";
test("Auth challenge is single-use, owner/origin/audience-bound and bounded; sessions expire and revoke", (t) => {
  const f = fixture(t),
    challenge = f.index.auth.challenge(owner, appOrigin);
  const p = presentation(challenge);
  assert.throws(() => f.index.auth.login(p, "https://zenith.example"), {
    code: "challenge-expired-or-used",
  });
  assert.throws(
    () =>
      f.index.auth.login(
        {
          ...p,
          challenge: {
            ...challenge,
            audience: "castalia-files://gateway/" + f.gateway.gatewayId,
          },
        },
        appOrigin,
      ),
    { code: "challenge-mismatch" },
  );
  const session = f.index.auth.login(p, appOrigin);
  assert.equal(f.index.auth.owner(session.token, appOrigin), owner);
  assert.throws(() => f.index.auth.login(p, appOrigin), {
    code: "challenge-expired-or-used",
  });
  assert.throws(
    () => f.index.auth.owner(session.token, "https://zenith.example"),
    { code: "session-expired-or-denied" },
  );
  f.advance(900001);
  assert.throws(() => f.index.auth.owner(session.token, appOrigin), {
    code: "session-expired-or-denied",
  });
  const c = f.index.auth.challenge(owner, appOrigin);
  f.advance(120001);
  assert.throws(() => f.index.auth.login(presentation(c), appOrigin), {
    code: "challenge-expired-or-used",
  });
  const s = f.index.auth.login(
    presentation(f.index.auth.challenge(owner, appOrigin)),
    appOrigin,
  );
  f.index.auth.logout(s.token, appOrigin);
  assert.throws(() => f.index.auth.owner(s.token, appOrigin), {
    code: "session-expired-or-denied",
  });
});
test("multipart journal resumes across gateway restart and exact part retry; wrong part bytes denied", async (t) => {
  const f = fixture(t),
    { manifest } = await register(f),
    s = intent(f, manifest);
  await f.gateway.upload(owner, s.signedIntent);
  await f.gateway.putPart(owner, id(1), 1, s.bytes);
  f.gateway.close();
  f.gateway = new FilesGateway(f.gatewayOptions);
  assert.equal(f.gateway.status(owner, id(1)).parts.length, 1);
  await f.gateway.putPart(owner, id(1), 1, s.bytes);
  await assert.rejects(
    f.gateway.putPart(owner, id(1), 1, Buffer.alloc(32, 9)),
    { code: "part-conflict" },
  );
  const receipt = await f.gateway.complete(owner, id(1));
  assert.equal(receipt.payload.pendingObjects, 0);
  assert.equal(f.transport.completed, 1);
  assert.deepEqual(await f.gateway.complete(owner, id(1)), receipt);
  assert.throws(() => f.gateway.status(other, id(1)), { code: "not-found" });
});
test("lost multipart completion acknowledgment reconciles exact immutable version and verifies fresh bytes", async (t) => {
  const f = fixture(t),
    { manifest } = await register(f),
    s = intent(f, manifest);
  f.transport.loseCompletion = true;
  const receipt = await stored(f, s);
  assert.equal(f.transport.completed, 1);
  assert.equal(f.transport.reads, 1);
  assert.equal(receipt.payload.objectVersion, "2");
});
test("flush success with pending or unpinned objects never creates a stored receipt", async (t) => {
  const f = fixture(t),
    { manifest } = await register(f),
    s = intent(f, manifest);
  await f.gateway.upload(owner, s.signedIntent);
  await f.gateway.putPart(owner, id(1), 1, s.bytes);
  f.transport.pending = 1;
  await assert.rejects(f.gateway.complete(owner, id(1)), {
    code: "storage-not-durable",
  });
  assert.equal(f.gateway.status(owner, id(1)).receipt, null);
  f.transport.pending = 0;
  f.transport.unpinned = 1;
  await assert.rejects(f.gateway.complete(owner, id(1)), {
    code: "storage-not-durable",
  });
  assert.equal(f.transport.reads, 0);
  f.transport.unpinned = 0;
  await f.gateway.complete(owner, id(1));
  assert.equal(f.transport.completed, 1);
});
test("fresh read integrity mismatch, quota failure and missing parts remain recoverable failures", async (t) => {
  const f = fixture(t),
    { manifest } = await register(f),
    s = intent(f, manifest);
  await f.gateway.upload(owner, s.signedIntent);
  await assert.rejects(f.gateway.complete(owner, id(1)), {
    code: "missing-parts",
  });
  await f.gateway.putPart(owner, id(1), 1, s.bytes);
  f.transport.flushError = true;
  await assert.rejects(f.gateway.complete(owner, id(1)));
  f.transport.flushError = false;
  f.transport.corrupt = true;
  await assert.rejects(f.gateway.complete(owner, id(1)), {
    code: "stored-integrity-mismatch",
  });
  assert.equal(f.gateway.status(owner, id(1)).receipt, null);
  f.transport.corrupt = false;
  await f.gateway.complete(owner, id(1));
  assert.equal(f.transport.completed, 1);
});
test("wrong owner, untrusted intent signer, expired intent, and account budget deny upload", async (t) => {
  const f = fixture(t),
    { manifest } = await register(f),
    s = intent(f, manifest);
  await assert.rejects(f.gateway.upload(other, s.signedIntent), {
    code: "intent-denied",
  });
  await assert.rejects(
    f.gateway.upload(owner, { ...s.signedIntent, keyId: id(90) }),
    { code: "untrusted-index" },
  );
  f.gateway.maxAccountBytes = 16;
  await assert.rejects(f.gateway.upload(owner, s.signedIntent), {
    code: "storage-budget-exceeded",
  });
  f.gateway.maxAccountBytes = 1000;
  f.advance(86400001);
  await assert.rejects(f.gateway.upload(owner, s.signedIntent), {
    code: "intent-denied",
  });
});
test("lost initiation acknowledgment resumes only from a unique exact-key multipart listing", async (t) => {
  const f = fixture(t),
    { manifest } = await register(f),
    s = intent(f, manifest);
  f.transport.loseInitialization = true;
  await assert.rejects(f.gateway.upload(owner, s.signedIntent));
  assert.equal(
    f.gateway.status(owner, id(1)).state,
    "initialization-uncertain",
  );
  f.gateway.close();
  f.gateway = new FilesGateway(f.gatewayOptions);
  await f.gateway.upload(owner, s.signedIntent);
  assert.equal(f.gateway.status(owner, id(1)).state, "uploading");
  await f.gateway.putPart(owner, id(1), 1, s.bytes);
  await f.gateway.complete(owner, id(1));
  assert.equal(f.transport.completed, 1);
});
test("account operator can deny new payer access without removing uploader read", async (t) => {
  const f = fixture(t),
    { manifest } = await register(f),
    s = intent(f, manifest);
  await stored(f, s);
  f.gateway.allowedMembers.delete(owner);
  const next = intent(f, manifest, {
    operationId: id(20),
    revisionId: id(21),
    submissionId: id(22),
  });
  await assert.rejects(f.gateway.upload(owner, next.signedIntent), {
    code: "intent-denied",
  });
  assert.ok((await f.gateway.download(owner, id(1))).stream);
});
test("multi-part ordering, omitted parts and exact final size remain bound after resume", async (t) => {
  const f = fixture(t),
    { manifest } = await register(f),
    bytes = Buffer.alloc(8 * 1024 * 1024 + 32, 5),
    s = intent(f, manifest, { bytes });
  await f.gateway.upload(owner, s.signedIntent);
  await f.gateway.putPart(owner, id(1), 2, bytes.subarray(8 * 1024 * 1024));
  await assert.rejects(f.gateway.complete(owner, id(1)), {
    code: "missing-parts",
  });
  await assert.rejects(f.gateway.putPart(owner, id(1), 1, Buffer.alloc(31)), {
    code: "invalid-part",
  });
  await f.gateway.putPart(owner, id(1), 1, bytes.subarray(0, 8 * 1024 * 1024));
  const receipt = await f.gateway.complete(owner, id(1));
  assert.equal(receipt.payload.byteLength, bytes.length);
  assert.equal(f.gateway.status(owner, id(1)).parts.length, 2);
});
test("operator removal prevents additional bytes and pinning costs for an in-flight upload", async (t) => {
  const f = fixture(t),
    { manifest } = await register(f),
    s = intent(f, manifest);
  await f.gateway.upload(owner, s.signedIntent);
  f.gateway.allowedMembers.delete(owner);
  await assert.rejects(f.gateway.putPart(owner, id(1), 1, s.bytes), {
    code: "account-admission-denied",
  });
  await assert.rejects(f.gateway.complete(owner, id(1)), {
    code: "account-admission-denied",
  });
  assert.equal(f.transport.completed, 0);
});
test("shared receipt decoders reject unknown schemas, extensions and unversioned object claims", async (t) => {
  const f = fixture(t),
    { manifest } = await register(f),
    s = intent(f, manifest),
    receipt = await stored(f, s);
  const { parseStorageReceipt, parseUploadIntent, verifyServiceEnvelope } =
    await import("../../packages/browser/src/shipping-receipts.mjs");
  for (const payload of [
    { ...receipt.payload, schema: "castalia.files-storage-receipt.v2" },
    { ...receipt.payload, extra: true },
    { ...receipt.payload, objectVersion: "null" },
    { ...receipt.payload, unpinnedObjects: 1 },
  ])
    assert.throws(() => parseStorageReceipt(payload), {
      code: "invalid-receipt",
    });
  assert.throws(
    () => parseUploadIntent({ ...s.signedIntent.payload, universeId: id(90) }),
    { code: "invalid-receipt" },
  );
  await assert.rejects(
    verifyServiceEnvelope(receipt, id(90), parseStorageReceipt),
    { code: "invalid-receipt" },
  );
});
test('second gateway process owner is refused until the first cleanly releases its state lock',async t=>{const f=fixture(t);assert.throws(()=>new FilesGateway(f.gatewayOptions),{code:'gateway-already-owned'});f.gateway.close();f.gateway=new FilesGateway(f.gatewayOptions);assert.equal(f.gateway.config().storageAccountId,'synthetic');});
