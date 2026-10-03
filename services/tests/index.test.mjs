import test from "node:test";
import assert from "node:assert/strict";
import { FilesIndex } from "../src/index.mjs";
import {
  verifyServiceEnvelope,
  parseIndexAcceptance,
  parseNamespaceAcceptance,
} from "../../packages/browser/src/shipping-receipts.mjs";
import {
  fixture,
  register,
  intent,
  stored,
  commitInput,
  owner,
  other,
  id,
  serviceId,
  credential,
  genesis,
  signed,
} from "./helpers.mjs";
import { PERSON_CLASS } from "../../packages/browser/src/registration.mjs";
test("accepted personal namespace is unique and independently signature-bound; Zenith remains pending", async (t) => {
  const f = fixture(t),
    { manifest, accepted } = await register(f);
  assert.equal(
    (
      await verifyServiceEnvelope(
        accepted.receipt,
        serviceId,
        parseNamespaceAcceptance,
      )
    ).namespaceId,
    manifest.namespaceId,
  );
  assert.equal(
    f.index.personal(owner).registration.chain[0].manifest.namespaceId,
    manifest.namespaceId,
  );
  assert.equal(f.index.destinations(owner).zenith.state, "pending");
  const competing = await genesis({
    entityClass: PERSON_CLASS,
    genesisNonce: "00".repeat(32),
    initialWorkspaceId: id(77),
  });
  await assert.rejects(
    f.index.acceptRegistration(owner, {
      chain: [signed(competing)],
      membershipCredential: credential,
      expectedManifestDigest: null,
    }),
    { code: "registration-conflict" },
  );
  assert.equal(f.index.namespaces(other).length, 0);
});
test("commit atomically survives restart, retries exactly once, binds descriptor metadata and rejects stale heads", async (t) => {
  const f = fixture(t),
    { manifest } = await register(f),
    shipment = intent(f, manifest),
    receipt = await stored(f, shipment),
    body = commitInput(shipment, receipt);
  const first = f.index.commit(owner, body);
  assert.equal(
    (await verifyServiceEnvelope(first, serviceId, parseIndexAcceptance))
      .sequence,
    1,
  );
  assert.deepEqual(f.index.commit(owner, body), first);
  f.index.close();
  f.index = new FilesIndex(f.indexOptions);
  assert.deepEqual(f.index.operation(owner, id(1)).acceptance, first);
  assert.equal(f.index.inventory(owner).length, 1);
  assert.equal(f.index.revision(owner, id(2), id(3)).nonce, body.nonce);
  assert.throws(
    () =>
      f.index.commit(owner, {
        ...body,
        nonce: Buffer.alloc(12, 2).toString("base64url"),
      }),
    { code: "operation-conflict" },
  );
  assert.throws(
    () => intent(f, manifest, { operationId: id(4), revisionId: id(5) }),
    { code: "head-conflict" },
  );
  assert.throws(() => f.index.history(other, id(2)), { code: "not-found" });
});
test("two valid competing revisions may store, but one CAS wins and losing receipt remains reconcilable", async (t) => {
  const f = fixture(t),
    { manifest } = await register(f),
    a = intent(f, manifest),
    b = intent(f, manifest, { operationId: id(4), revisionId: id(5) });
  const ar = await stored(f, a),
    br = await stored(f, b);
  f.index.commit(owner, commitInput(a, ar));
  assert.throws(() => f.index.commit(owner, commitInput(b, br)), {
    code: "head-conflict",
  });
  assert.equal(f.index.operation(owner, id(4)).acceptance, null);
  assert.equal(f.gateway.status(owner, id(4)).state, "stored");
  assert.equal(f.index.history(owner, id(2)).revisions.length, 1);
});
test("revocation between storage and index acceptance denies publication but preserves uploader read and withdrawal", async (t) => {
  const f = fixture(t),
    { manifest, accepted } = await register(f, true);
  f.index.canonicalBindings = [
    {
      alias: "zenith",
      namespaceId: manifest.namespaceId,
      registrationGenesisDigest:
        accepted.receipt.payload.registrationGenesisDigest,
    },
  ];
  f.index.setGrant(owner, {
    namespaceId: manifest.namespaceId,
    granteeMemberKey: other,
    workspaceId: manifest.initialWorkspaceId,
    actions: ["submit", "update-own", "withdraw-own"],
    maxBytes: 1000,
    expiresAt: "2026-10-04T00:00:00.000Z",
  });
  const first = intent(f, manifest, { memberKey: other });
  const receipt = await stored(f, first);
  f.index.commit(other, commitInput(first, receipt));
  const next = intent(f, manifest, {
    memberKey: other,
    operationId: id(9),
    revisionId: id(10),
    expectedRevisionId: id(3),
  });
  const nextReceipt = await stored(f, next);
  f.index.revokeGrant(owner, {
    namespaceId: manifest.namespaceId,
    granteeMemberKey: other,
  });
  assert.throws(() => f.index.commit(other, commitInput(next, nextReceipt)), {
    code: "namespace-admission-denied",
  });
  assert.equal(f.index.history(other, id(2)).revisions.length, 1);
  const download = await f.gateway.download(other, id(1));
  assert.equal(download.receipt.payload.ownerMemberKey, other);
  assert.equal(
    f.index.withdraw(other, { submissionId: id(2), expectedRevisionId: id(3) })
      .remoteDeletion,
    false,
  );
  assert.equal(f.index.inventory(other)[0].withdrawn, true);
  assert.throws(() => f.index.history(owner, id(2)), { code: "not-found" });
});
test("receipt substitution and metadata tampering cannot publish a head", async (t) => {
  const f = fixture(t),
    { manifest } = await register(f),
    shipment = intent(f, manifest),
    receipt = await stored(f, shipment),
    body = commitInput(shipment, receipt);
  assert.throws(
    () => f.index.commit(owner, { ...body, descriptorDigest: id(99) }),
    { code: "storage-binding-mismatch" },
  );
  assert.throws(() =>
    f.index.commit(owner, {
      ...body,
      storageReceipt: {
        ...receipt,
        payload: { ...receipt.payload, pendingObjects: 1 },
      },
    }),
  );
  assert.equal(f.index.inventory(owner).length, 0);
  assert.equal(f.index.operation(owner, id(1)).acceptance, null);
});
test("owner connection discovery survives restart and never stores storage credentials", async (t) => {
  const f = fixture(t);
  const connection = {
    gatewayUrl: "https://gateway.example/",
    gatewayId: f.gateway.gatewayId,
    storageAccountId: "synthetic",
    providerName: "Synthetic",
    termsUrl: "https://provider.example/terms",
    budgetBytes: 1000,
  };
  f.index.saveConnection(owner, connection);
  f.index.close();
  f.index = new FilesIndex(f.indexOptions);
  assert.deepEqual(f.index.connections(owner), [
    { ...connection, gatewayUrl: "https://gateway.example" },
  ]);
  assert.deepEqual(f.index.connections(other), []);
  assert.throws(
    () => f.index.saveConnection(owner, { ...connection, secretKey: "never" }),
    { code: "invalid-shape" },
  );
});
test("explicit owner byte budget is enforced before issuing any new intent", async (t) => {
  const f = fixture(t),
    { manifest } = await register(f);
  f.index.saveConnection(owner, {
    gatewayUrl: "https://gateway.example/",
    gatewayId: f.gateway.gatewayId,
    storageAccountId: "synthetic",
    providerName: "Synthetic",
    termsUrl: "https://provider.example/terms",
    budgetBytes: 40,
  });
  intent(f, manifest);
  assert.throws(
    () =>
      intent(f, manifest, {
        operationId: id(42),
        submissionId: id(43),
        revisionId: id(44),
      }),
    { code: "owner-storage-budget-exceeded" },
  );
  assert.throws(() => f.index.operation(owner, id(42)), { code: "not-found" });
});
test("admission grant is an index-signed current-controller acceptance and cannot be delegated onward", async (t) => {
  const f = fixture(t),
    { manifest } = await register(f, true);
  const grant = {
    namespaceId: manifest.namespaceId,
    granteeMemberKey: other,
    workspaceId: null,
    actions: ["submit"],
    maxBytes: 100,
    expiresAt: "2026-10-04T00:00:00.000Z",
  };
  const envelope = f.index.setGrant(owner, grant);
  const { verifyEnvelope } = await import("../src/common.mjs");
  assert.equal(
    verifyEnvelope(envelope, f.index.serviceId).issuerControllerMemberKey,
    owner,
  );
  assert.equal(envelope.payload.schema, "castalia.files-admission-grant.v1");
  assert.throws(
    () => f.index.setGrant(other, { ...grant, granteeMemberKey: owner }),
    { code: "controller-denied" },
  );
  assert.throws(
    () => f.index.setGrant(owner, { ...grant, actions: ["read"] }),
    { code: "invalid-grant" },
  );
  assert.throws(
    () => f.index.setGrant(owner, { ...grant, actions: ["delegate"] }),
    { code: "invalid-grant" },
  );
});

test("organization admission requires the exact accepted canonical binding at intent and commit", async (t) => {
  const f = fixture(t),
    { manifest, accepted } = await register(f, true);
  assert.equal(f.index.namespaces(owner).length, 0);
  assert.throws(() => intent(f, manifest), {
    code: "namespace-admission-denied",
  });
  f.index.canonicalBindings = [
    {
      alias: "zenith",
      namespaceId: manifest.namespaceId,
      registrationGenesisDigest: id(987),
    },
  ];
  assert.equal(f.index.destinations(owner).zenith.state, "pending");
  assert.throws(() => intent(f, manifest), {
    code: "namespace-admission-denied",
  });
  f.index.canonicalBindings[0].registrationGenesisDigest =
    accepted.receipt.payload.registrationGenesisDigest;
  assert.equal(f.index.destinations(owner).zenith.canSubmit, false);
  assert.throws(() => intent(f, manifest), {
    code: "namespace-admission-denied",
  });
  f.index.setGrant(owner, {
    namespaceId: manifest.namespaceId,
    granteeMemberKey: owner,
    workspaceId: manifest.initialWorkspaceId,
    actions: ["submit"],
    maxBytes: 100,
    expiresAt: "2026-10-04T00:00:00.000Z",
  });
  assert.equal(f.index.destinations(owner).zenith.canSubmit, true);
  const shipment = intent(f, manifest),
    receipt = await stored(f, shipment);
  f.index.canonicalBindings = [];
  assert.throws(() => f.index.commit(owner, commitInput(shipment, receipt)), {
    code: "namespace-admission-denied",
  });
  assert.equal(f.index.inventory(owner).length, 0);
  assert.equal(
    (await f.gateway.download(owner, shipment.input.operationId)).receipt
      .payload.ownerMemberKey,
    owner,
  );
});

test("an organization controller needs an explicit bounded self-grant for uploads", async (t) => {
  const f = fixture(t),
    { manifest, accepted } = await register(f, true);
  f.index.canonicalBindings = [
    {
      alias: "zenith",
      namespaceId: manifest.namespaceId,
      registrationGenesisDigest:
        accepted.receipt.payload.registrationGenesisDigest,
    },
  ];
  assert.equal(f.index.namespaces(owner).length, 0);
  assert.throws(() => intent(f, manifest), {
    code: "namespace-admission-denied",
  });
  f.index.setGrant(owner, {
    namespaceId: manifest.namespaceId,
    granteeMemberKey: owner,
    workspaceId: manifest.initialWorkspaceId,
    actions: ["submit"],
    maxBytes: 32,
    expiresAt: "2026-10-04T00:00:00.000Z",
  });
  assert.equal(f.index.namespaces(owner).length, 1);
  assert.throws(() => intent(f, manifest, { bytes: Buffer.alloc(33) }), {
    code: "namespace-admission-denied",
  });
  const shipment = intent(f, manifest),
    receipt = await stored(f, shipment);
  f.index.commit(owner, commitInput(shipment, receipt));
  assert.throws(
    () =>
      intent(f, manifest, {
        operationId: id(25),
        revisionId: id(26),
        expectedRevisionId: id(3),
      }),
    { code: "namespace-admission-denied" },
  );
  f.advance(86400000);
  assert.equal(f.index.namespaces(owner).length, 0);
  assert.throws(
    () =>
      intent(f, manifest, {
        operationId: id(27),
        submissionId: id(28),
        revisionId: id(29),
      }),
    { code: "namespace-admission-denied" },
  );
  assert.equal(f.index.history(owner, id(2)).revisions.length, 1);
});

test("organization discovery distinguishes update-own-only grants from fresh submission authority", async (t) => {
  const f = fixture(t),
    { manifest, accepted } = await register(f, true);
  f.index.canonicalBindings = [
    {
      alias: "zenith",
      namespaceId: manifest.namespaceId,
      registrationGenesisDigest:
        accepted.receipt.payload.registrationGenesisDigest,
    },
  ];
  const grant = {
    namespaceId: manifest.namespaceId,
    granteeMemberKey: owner,
    workspaceId: manifest.initialWorkspaceId,
    actions: ["submit", "update-own"],
    maxBytes: 32,
    expiresAt: "2026-10-04T00:00:00.000Z",
  };
  f.index.setGrant(owner, grant);
  const first = intent(f, manifest),
    firstReceipt = await stored(f, first);
  f.index.commit(owner, commitInput(first, firstReceipt));
  f.index.setGrant(owner, { ...grant, actions: ["update-own"] });
  assert.equal(f.index.namespaces(owner).length, 1);
  assert.equal(f.index.destinations(owner).zenith.canSubmit, false);
  assert.equal(f.index.destinations(owner).zenith.canUpdateOwn, true);
  assert.throws(
    () =>
      intent(f, manifest, {
        operationId: id(31),
        submissionId: id(32),
        revisionId: id(33),
      }),
    { code: "namespace-admission-denied" },
  );
  const next = intent(f, manifest, {
    operationId: id(34),
    revisionId: id(35),
    expectedRevisionId: id(3),
  });
  f.index.commit(owner, commitInput(next, await stored(f, next)));
  assert.equal(f.index.inventory(owner)[0].sequence, 2);
  f.index.revokeGrant(owner, {
    namespaceId: manifest.namespaceId,
    granteeMemberKey: owner,
  });
  assert.equal(f.index.namespaces(owner).length, 0);
  assert.equal(f.index.destinations(owner).zenith.canUpdateOwn, false);
  assert.throws(
    () =>
      intent(f, manifest, {
        operationId: id(36),
        revisionId: id(37),
        expectedRevisionId: id(35),
      }),
    { code: "namespace-admission-denied" },
  );
  assert.equal(f.index.history(owner, id(2)).revisions.length, 2);
});
