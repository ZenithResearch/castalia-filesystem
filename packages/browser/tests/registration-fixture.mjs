import { createPrivateKey, createPublicKey, sign } from "node:crypto";
import { readFile } from "node:fs/promises";
import {
  createRegistrationManifest,
  ORGANIZATION_CLASS,
  SIGNED_REGISTRATION_SCHEMA,
  registrationSigningBytes,
  registrationManifestDigest,
  verifyRegistrationChain,
} from "../src/registration.mjs";
export const fixture = JSON.parse(
  await readFile(
    new URL("./fixtures/base-membership-v3.json", import.meta.url),
    "utf8",
  ),
);
export const credential = fixture.credential;
export const trustPolicy = {
  schema: "castalia.zenith-membership-trust-policy.v1",
  version: 1,
  roots: [
    {
      issuerId: credential.issuerId,
      keyId: credential.issuerKeyId,
      signatureSuite: "Ed25519",
      publicKey: fixture.issuerPublicKey,
    },
  ],
};
const ownerSeed =
  "4ccd089b28ff96da9db6c346ec114e0f5b8a319f35aba624da8cf6ed4fb8a6fb";
const ownerPrivate = createPrivateKey({
  key: Buffer.from("302e020100300506032b657004220420" + ownerSeed, "hex"),
  format: "der",
  type: "pkcs8",
});
const otherPrivate = createPrivateKey({
  key: Buffer.from("302e020100300506032b657004220420" + "07".repeat(32), "hex"),
  format: "der",
  type: "pkcs8",
});
export const otherKey = createPublicKey(otherPrivate)
  .export({ format: "der", type: "spki" })
  .subarray(-32)
  .toString("hex");
export function signed(manifest, other = false) {
  return {
    schema: SIGNED_REGISTRATION_SCHEMA,
    manifest,
    signerMemberKey: other ? otherKey : credential.ownerPublicKey,
    signatureSuite: "Ed25519",
    signature: sign(
      null,
      registrationSigningBytes(manifest),
      other ? otherPrivate : ownerPrivate,
    ).toString("base64url"),
  };
}
export async function genesis(overrides = {}) {
  return createRegistrationManifest({
    entityClass: ORGANIZATION_CLASS,
    creatorMemberKey: credential.ownerPublicKey,
    genesisNonce: "11".repeat(32),
    initialWorkspaceId: "22".repeat(32),
    displayName: "Synthetic Organization",
    ...overrides,
  });
}
export async function verified(chain) {
  return verifyRegistrationChain(chain, {
    membershipCredential: credential,
    trustPolicy,
  });
}
export async function update(previous, changes = {}) {
  return {
    ...previous,
    revision: previous.revision + 1,
    previousManifestDigest: await registrationManifestDigest(previous),
    ...changes,
  };
}
