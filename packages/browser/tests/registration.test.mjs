import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  createRegistrationManifest,
  ORGANIZATION_CLASS,
  PERSON_CLASS,
  SIGNED_REGISTRATION_SCHEMA,
  registrationSigningBytes,
  registrationManifestDigest,
  verifyRegistrationChain,
  verifySignedRegistration,
  parseRegistrationManifest,
  validateRegistrationRequest,
  signatureBytes,
} from "../src/registration.mjs";
import {
  baseMembershipSigningBytes,
  verifyBaseMembership,
} from "../src/registration-membership.mjs";
import { parseAddress, workspaceKey } from "../src/address.mjs";
import {
  fixture,
  credential,
  trustPolicy,
  otherKey,
  signed,
  genesis,
  verified,
  update,
} from "./registration-fixture.mjs";

test("existing v3 credential bytes and signature remain compatible", async () => {
  assert.equal(
    Buffer.from(baseMembershipSigningBytes(credential)).toString("hex"),
    fixture.credentialHex,
  );
  assert.deepEqual(
    await verifyBaseMembership(
      credential,
      trustPolicy,
      credential.ownerPublicKey,
    ),
    credential,
  );
  await assert.rejects(
    verifyBaseMembership(
      { ...credential, schema: "castalia.membership.v4" },
      trustPolicy,
      credential.ownerPublicKey,
    ),
  );
  await assert.rejects(
    verifyBaseMembership(
      credential,
      { ...trustPolicy, roots: [] },
      credential.ownerPublicKey,
    ),
  );
  await assert.rejects(verifyBaseMembership(credential, trustPolicy, otherKey));
  await assert.rejects(
    verifyBaseMembership(
      { ...credential, membershipId: "00".repeat(32) },
      trustPolicy,
      credential.ownerPublicKey,
    ),
  );
  await assert.rejects(
    verifyBaseMembership(
      { ...credential, issuerSignature: "A".repeat(86) },
      trustPolicy,
      credential.ownerPublicKey,
    ),
  );
});
test("fixed registration vector is stable and identity is derived independently of labels", async () => {
  const manifest = await genesis();
  const vector = JSON.parse(
    await readFile(
      new URL("./fixtures/registration-v1.json", import.meta.url),
      "utf8",
    ),
  );
  assert.deepEqual(manifest, vector.manifest);
  assert.equal(
    Buffer.from(registrationSigningBytes(manifest)).toString("hex"),
    vector.signingHex,
  );
  assert.equal(
    await registrationManifestDigest(manifest),
    vector.manifestDigest,
  );
  const changed = await genesis({ displayName: "Other label" });
  assert.equal(changed.entityRef, manifest.entityRef);
  assert.equal(changed.namespaceId, manifest.namespaceId);
  const other = await genesis({ genesisNonce: "33".repeat(32) });
  assert.notEqual(other.entityRef, manifest.entityRef);
  const value = await verified([signed(manifest)]);
  assert.equal(value.manifestDigest, vector.manifestDigest);
  assert.notEqual(manifest.namespaceId, manifest.initialWorkspaceId);
  assert.notEqual(manifest.entityRef, credential.ownerPublicKey);
});
test("one personal identity per member; unknown fields and invalid encodings fail closed", async () => {
  const first = await genesis({
    entityClass: PERSON_CLASS,
    genesisNonce: "00".repeat(32),
  });
  const second = await genesis({
    entityClass: PERSON_CLASS,
    genesisNonce: "00".repeat(32),
    initialWorkspaceId: "33".repeat(32),
  });
  assert.equal(first.namespaceId, second.namespaceId);
  await assert.rejects(genesis({ entityClass: PERSON_CLASS }));
  await assert.rejects(genesis({ genesisNonce: "00".repeat(32) }));
  assert.throws(() =>
    parseRegistrationManifest({ ...first, universeId: "44".repeat(32) }),
  );
  assert.throws(() =>
    parseRegistrationManifest({ ...first, displayName: " hidden" }),
  );
  assert.throws(() =>
    parseAddress({ namespaceId: "../bad", workspaceId: "22".repeat(32) }),
  );
  assert.throws(() =>
    parseAddress({
      namespaceId: first.namespaceId,
      workspaceId: "22".repeat(32),
      federationId: "zenith",
    }),
  );
  assert.deepEqual(
    workspaceKey({
      namespaceId: first.namespaceId,
      workspaceId: "22".repeat(32),
    }),
    ["workspace-v1", first.namespaceId, "22".repeat(32)],
  );
  const valid = signed(first).signature;
  const alphabet =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  const last = alphabet.indexOf(valid.at(-1));
  assert.throws(() => signatureBytes(valid.slice(0, -1) + alphabet[last + 1]));
});
test("all mutable and immutable fields are signature-bound; derived ID mismatch is rejected", async () => {
  const manifest = await genesis(),
    envelope = signed(manifest);
  for (const change of [
    { displayName: "Altered" },
    { controllerMemberKey: otherKey },
    { initialWorkspaceId: "77".repeat(32) },
    { namespaceId: "77".repeat(32) },
    { entityRef: "urn:castalia:entity:" + "77".repeat(32) },
  ]) {
    await assert.rejects(
      verifySignedRegistration({
        ...envelope,
        manifest: { ...manifest, ...change },
      }),
    );
  }
  await assert.rejects(
    verified([signed({ ...manifest, namespaceId: "77".repeat(32) })]),
  );
  await assert.rejects(
    verified([signed({ ...manifest, controllerMemberKey: otherKey })]),
  );
  await assert.rejects(verified([signed(manifest, true)]));
});
test("controller rotation preserves entity and requires the previous controller and exact digest", async () => {
  const first = await genesis(),
    second = await update(first, { controllerMemberKey: otherKey }),
    third = await update(second, { displayName: "Renamed" });
  assert.equal(
    (await verified([signed(first), signed(second), signed(third, true)]))
      .manifest.controllerMemberKey,
    otherKey,
  );
  await assert.rejects(verified([signed(first), signed(second, true)]));
  await assert.rejects(
    verified([signed(first), signed(second), signed(third)]),
  );
  await assert.rejects(
    verified([
      signed(first),
      signed({ ...second, previousManifestDigest: "99".repeat(32) }),
    ]),
  );
  await assert.rejects(
    verified([
      signed(first),
      signed({ ...second, initialWorkspaceId: "99".repeat(32) }),
    ]),
  );
  await assert.rejects(
    verified([signed(first), signed({ ...second, revision: 2 })]),
  );
  await assert.rejects(verified(Array(257).fill(signed(first))));
});
test("fresh consent binds requester, audience, manifest, nonce syntax and deadline", async () => {
  const manifest = await genesis();
  const consent = {
    requestId: "synthetic_request_01",
    origin: "https://example.test",
    audience: "https://example.test",
    nonce: "aa".repeat(32),
    issuedAtMs: 1000,
    expiresAtMs: 2000,
    manifestDigest: await registrationManifestDigest(manifest),
  };
  const context = {
    origin: "https://example.test",
    audience: "https://example.test",
    nowMs: 1500,
  };
  await validateRegistrationRequest({ manifest, consent }, context);
  for (const change of [
    { origin: "https://other.test" },
    { audience: "https://other.test" },
    { manifestDigest: "ff".repeat(32) },
    { nonce: "short" },
    { issuedAtMs: 1600 },
    { expiresAtMs: 1500 },
    { expiresAtMs: 200000 },
  ])
    await assert.rejects(
      validateRegistrationRequest(
        { manifest, consent: { ...consent, ...change } },
        context,
      ),
    );
  await assert.rejects(
    validateRegistrationRequest(
      { manifest: { ...manifest, displayName: "Other" }, consent },
      context,
    ),
  );
  // Durable signatures retain validity after the request deadline; consent is not a stored grant.
  await verifySignedRegistration(signed(manifest));
});
