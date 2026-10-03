// SPDX-License-Identifier: AGPL-3.0-or-later
// Wire-compatible verifier of the existing Wallet v3 contract; see IDENTITY-MAPPING.md.
import { exact, hex32, RegistrationError } from "./address.mjs";
import {
  bytesFromHex,
  sha256,
  signatureBytes,
  verifyEd25519,
} from "./registration-crypto.mjs";
const encoder = new TextEncoder();
const identifier = /^[a-z0-9](?:[a-z0-9.-]{0,62}[a-z0-9])?$/u;
function frame(value) {
  if (typeof value !== "string" || !identifier.test(value))
    throw new RegistrationError("invalid", "Invalid v3 identifier");
  const bytes = encoder.encode(value),
    result = new Uint8Array(4 + bytes.length);
  new DataView(result.buffer).setUint32(0, bytes.length, true);
  result.set(bytes, 4);
  return result;
}
function concat(...parts) {
  const result = new Uint8Array(parts.reduce((sum, p) => sum + p.length, 0));
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}
export function parseBaseMembership(value) {
  exact(
    value,
    [
      "schema",
      "version",
      "membershipId",
      "ownerPublicKey",
      "status",
      "issuerId",
      "issuerKeyId",
      "signatureSuite",
      "issuerSignature",
    ],
    "base membership",
  );
  if (
    value.schema !== "castalia.zenith-membership-credential.v3" ||
    value.version !== 3 ||
    value.status !== "active" ||
    value.signatureSuite !== "Ed25519"
  )
    throw new RegistrationError(
      "invalid",
      "Active Castalia base v3 membership required",
    );
  hex32(value.membershipId);
  hex32(value.ownerPublicKey);
  frame(value.issuerId);
  frame(value.issuerKeyId);
  signatureBytes(value.issuerSignature);
  return structuredClone(value);
}
export function baseMembershipSigningBytes(value) {
  const v = parseBaseMembership(value),
    version = new Uint8Array(8);
  new DataView(version.buffer).setBigUint64(0, 3n, true);
  return concat(
    encoder.encode("castalia/zenith-membership-credential/v3\0"),
    version,
    bytesFromHex(v.membershipId),
    bytesFromHex(v.ownerPublicKey),
    frame(v.status),
    frame(v.issuerId),
    frame(v.issuerKeyId),
    frame("ed25519"),
  );
}
export async function verifyBaseMembership(input, policy, owner) {
  exact(policy, ["schema", "version", "roots"], "base membership trust policy");
  if (
    policy.schema !== "castalia.zenith-membership-trust-policy.v1" ||
    policy.version !== 1 ||
    !Array.isArray(policy.roots) ||
    policy.roots.length < 1 ||
    policy.roots.length > 256
  )
    throw new RegistrationError("invalid", "Invalid trust policy");
  const seen = new Set();
  for (const root of policy.roots) {
    exact(
      root,
      ["issuerId", "keyId", "signatureSuite", "publicKey"],
      "trust root",
    );
    frame(root.issuerId);
    frame(root.keyId);
    hex32(root.publicKey);
    const id = root.issuerId + "\0" + root.keyId;
    if (root.signatureSuite !== "Ed25519" || seen.has(id))
      throw new RegistrationError("invalid", "Invalid or duplicate trust root");
    seen.add(id);
  }
  const credential = parseBaseMembership(input);
  if (credential.ownerPublicKey !== hex32(owner))
    throw new RegistrationError("unauthorized", "Membership owner mismatch");
  const membershipId = await sha256(
    concat(
      encoder.encode("castalia/zenith-membership-id/v3\0"),
      bytesFromHex(owner),
    ),
  );
  if (credential.membershipId !== membershipId)
    throw new RegistrationError("invalid", "Membership ID mismatch");
  const root = policy.roots.find(
    (r) =>
      r.issuerId === credential.issuerId && r.keyId === credential.issuerKeyId,
  );
  if (!root)
    throw new RegistrationError(
      "unauthorized",
      "Untrusted base membership issuer",
    );
  await verifyEd25519(
    root.publicKey,
    credential.issuerSignature,
    baseMembershipSigningBytes(credential),
  );
  return credential;
}
