import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseFilesKeyBinding,
  canonicalBindingBytes,
  parseFilesKeyEnvelope,
  base64url,
  canonicalJson,
  authChallengeBytes,
  encryptShipment,
  decryptShipment,
} from "../src/shipping-contract.mjs";
const binding = {
  schema: "castalia.files-key-binding.v1",
  ownerMemberKey: "11".repeat(32),
  serviceId: "22".repeat(32),
  storageAccountId: "private-account",
  namespaceId: "33".repeat(32),
  workspaceId: "44".repeat(32),
  submissionId: "55".repeat(32),
  revisionId: "66".repeat(32),
};
test("fixed binding bytes ignore input insertion order and preserve exact scope", () => {
  assert.deepEqual(
    canonicalBindingBytes(
      Object.fromEntries(Object.entries(binding).reverse()),
    ),
    new TextEncoder().encode(JSON.stringify(binding)),
  );
  for (const delta of [
    { ownerMemberKey: "FF".repeat(32) },
    { storageAccountId: " account" },
    { schema: "future" },
    { extra: true },
  ])
    assert.throws(() => parseFilesKeyBinding({ ...binding, ...delta }));
});
test("key envelope is fixed size and rejects undeclared formats", () => {
  const e = {
    schema: "castalia.files-key-envelope.v1",
    binding,
    nonce: base64url(new Uint8Array(12)),
    ciphertext: base64url(new Uint8Array(48)),
  };
  assert.deepEqual(parseFilesKeyEnvelope(e), e);
  assert.throws(() =>
    parseFilesKeyEnvelope({ ...e, ciphertext: base64url(new Uint8Array(49)) }),
  );
});
test("canonical records reject ambiguous values", () => {
  assert.equal(
    canonicalJson({ z: 1, a: { b: true, a: null } }),
    '{"a":{"a":null,"b":true},"z":1}',
  );
  for (const value of [
    NaN,
    Infinity,
    -0,
    1.25,
    undefined,
    new Date(),
    JSON.parse('{"__proto__":1}'),
  ])
    assert.throws(() => canonicalJson(value));
});
test("existing Auth transcript order is retained but bounded to Files service audiences", () => {
  const c = {
    audience: "castalia-files://index/" + binding.serviceId,
    domain: "castalia-wallet",
    expiresAt: "2026-10-03T00:02:00.000Z",
    issuedAt: "2026-10-03T00:00:00.000Z",
    nonce: "0".repeat(32),
    operation: "castalia.wallet.signChallenge",
    origin: "https://castalia.example",
    version: 1,
  };
  assert.equal(
    new TextDecoder().decode(authChallengeBytes(c)),
    JSON.stringify(c),
  );
  assert.throws(() =>
    authChallengeBytes({ ...c, expiresAt: "2026-10-03T00:02:01.000Z" }),
  );
  assert.throws(() =>
    authChallengeBytes({ ...c, audience: "https://arbitrary.example" }),
  );
});
test("shipment ciphertext rejects substitution and corruption", async () => {
  const key = new Uint8Array(32).fill(8),
    plain = new TextEncoder().encode("private filename and content");
  const result = await encryptShipment(plain, key, binding);
  assert.deepEqual(
    await decryptShipment(result.ciphertext, key, binding, result.nonce),
    plain,
  );
  await assert.rejects(
    decryptShipment(
      result.ciphertext,
      key,
      { ...binding, workspaceId: "99".repeat(32) },
      result.nonce,
    ),
    /authentication/,
  );
  const corrupt = result.ciphertext.slice();
  corrupt[0] ^= 1;
  await assert.rejects(
    decryptShipment(corrupt, key, binding, result.nonce),
    /authentication/,
  );
});
