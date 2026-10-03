// SPDX-License-Identifier: AGPL-3.0-or-later
import { exact, hex32, entityKey, RegistrationError } from "./address.mjs";
import {
  sha256,
  signatureBytes,
  verifyEd25519,
} from "./registration-crypto.mjs";
export {
  sha256,
  signatureBytes,
  verifyEd25519,
  bytesFromHex,
} from "./registration-crypto.mjs";
import { verifyBaseMembership } from "./registration-membership.mjs";
export { RegistrationError } from "./address.mjs";
export { verifyBaseMembership } from "./registration-membership.mjs";
export const REGISTRATION_SCHEMA = "castalia.namespace-registration.v1";
export const SIGNED_REGISTRATION_SCHEMA =
  "castalia.signed-namespace-registration.v1";
export const REGISTRATION_DOMAIN = "castalia/namespace-registration/v1\0";
export const PERSON_CLASS = "https://zenith-research.ca/ontology/terms/Person";
export const ORGANIZATION_CLASS =
  "https://zenith-research.ca/ontology/terms/Organization";
export const MAX_REGISTRATION_REVISIONS = 256;
export const MAX_CONSENT_DURATION_MS = 120_000;
const ZERO = "0".repeat(64);
const encoder = new TextEncoder();
const verified = new WeakMap();
function text(value, label) {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 128 ||
    value.trim() !== value ||
    value.normalize("NFC") !== value ||
    /[\p{Cc}\p{Cs}]/u.test(value)
  )
    throw new RegistrationError("invalid", `Invalid ${label}`);
  return value;
}
function entityClass(value) {
  if (value !== PERSON_CLASS && value !== ORGANIZATION_CLASS)
    throw new RegistrationError("invalid", "Unsupported entity class");
  return value;
}
export function parseRegistrationManifest(value) {
  exact(
    value,
    [
      "schema",
      "entityRef",
      "entityClass",
      "creatorMemberKey",
      "genesisNonce",
      "namespaceId",
      "initialWorkspaceId",
      "controllerMemberKey",
      "displayName",
      "revision",
      "previousManifestDigest",
    ],
    "registration manifest",
  );
  if (
    value.schema !== REGISTRATION_SCHEMA ||
    !Number.isSafeInteger(value.revision) ||
    value.revision < 0 ||
    value.revision >= MAX_REGISTRATION_REVISIONS
  )
    throw new RegistrationError("invalid", "Unsupported registration revision");
  entityKey(value.entityRef);
  const result = {
    schema: REGISTRATION_SCHEMA,
    entityRef: value.entityRef,
    entityClass: entityClass(value.entityClass),
    creatorMemberKey: hex32(value.creatorMemberKey),
    genesisNonce: hex32(value.genesisNonce),
    namespaceId: hex32(value.namespaceId),
    initialWorkspaceId: hex32(value.initialWorkspaceId),
    controllerMemberKey: hex32(value.controllerMemberKey),
    displayName: text(value.displayName, "display name"),
    revision: value.revision,
    previousManifestDigest:
      value.previousManifestDigest === null
        ? null
        : hex32(value.previousManifestDigest),
  };
  if ((result.revision === 0) !== (result.previousManifestDigest === null))
    throw new RegistrationError(
      "invalid",
      "Revision and previous digest disagree",
    );
  if (result.entityClass === PERSON_CLASS && result.genesisNonce !== ZERO)
    throw new RegistrationError(
      "invalid",
      "Personal genesis nonce must be zero",
    );
  if (result.entityClass === ORGANIZATION_CLASS && result.genesisNonce === ZERO)
    throw new RegistrationError(
      "invalid",
      "Organization requires a fresh genesis nonce",
    );
  return Object.freeze(result);
}
async function deriveIds(entityClassValue, creatorMemberKey, genesisNonce) {
  const entityDigest = await sha256(
    encoder.encode(
      "castalia/entity-genesis/v1\0" +
        JSON.stringify({
          entityClass: entityClassValue,
          creatorMemberKey,
          genesisNonce,
        }),
    ),
  );
  const entityRef = `urn:castalia:entity:${entityDigest}`;
  const namespaceId = await sha256(
    encoder.encode("castalia/entity-namespace/v1\0" + entityRef),
  );
  return { entityRef, namespaceId };
}
/** Allocate a new opaque entity, not an existing organization by name. */
export async function createRegistrationManifest(input) {
  exact(
    input,
    [
      "entityClass",
      "creatorMemberKey",
      "genesisNonce",
      "initialWorkspaceId",
      "displayName",
    ],
    "registration genesis input",
  );
  const kind = entityClass(input.entityClass),
    creator = hex32(input.creatorMemberKey),
    nonce = hex32(input.genesisNonce);
  const ids = await deriveIds(kind, creator, nonce);
  return parseRegistrationManifest({
    schema: REGISTRATION_SCHEMA,
    ...ids,
    entityClass: kind,
    creatorMemberKey: creator,
    genesisNonce: nonce,
    initialWorkspaceId: input.initialWorkspaceId,
    controllerMemberKey: creator,
    displayName: input.displayName,
    revision: 0,
    previousManifestDigest: null,
  });
}
export function registrationSigningBytes(input) {
  return encoder.encode(
    REGISTRATION_DOMAIN + JSON.stringify(parseRegistrationManifest(input)),
  );
}
export async function registrationManifestDigest(input) {
  return sha256(registrationSigningBytes(input));
}
export async function validateRegistrationIdentity(input) {
  const manifest = parseRegistrationManifest(input);
  const expected = await deriveIds(
    manifest.entityClass,
    manifest.creatorMemberKey,
    manifest.genesisNonce,
  );
  if (
    expected.entityRef !== manifest.entityRef ||
    expected.namespaceId !== manifest.namespaceId
  )
    throw new RegistrationError(
      "invalid",
      "Entity or namespace derivation mismatch",
    );
  return manifest;
}
export function parseSignedRegistration(value) {
  exact(
    value,
    ["schema", "manifest", "signerMemberKey", "signatureSuite", "signature"],
    "signed registration",
  );
  if (
    value.schema !== SIGNED_REGISTRATION_SCHEMA ||
    value.signatureSuite !== "Ed25519"
  )
    throw new RegistrationError(
      "invalid",
      "Unsupported registration signature suite",
    );
  signatureBytes(value.signature);
  return Object.freeze({
    schema: SIGNED_REGISTRATION_SCHEMA,
    manifest: parseRegistrationManifest(value.manifest),
    signerMemberKey: hex32(value.signerMemberKey),
    signatureSuite: "Ed25519",
    signature: value.signature,
  });
}
/** Only a signature check. Controller authority is established by verifyRegistrationChain. */
export async function verifySignedRegistration(input) {
  const signed = parseSignedRegistration(input);
  await validateRegistrationIdentity(signed.manifest);
  await verifyEd25519(
    signed.signerMemberKey,
    signed.signature,
    registrationSigningBytes(signed.manifest),
  );
  return signed;
}
/** Verify the complete bounded chain before any IndexedDB transaction. */
export async function verifyRegistrationChain(
  input,
  { membershipCredential, trustPolicy },
) {
  if (
    !Array.isArray(input) ||
    input.length < 1 ||
    input.length > MAX_REGISTRATION_REVISIONS
  )
    throw new RegistrationError("limit", "Invalid registration chain length");
  const chain = input.map(parseSignedRegistration);
  const genesis = chain[0].manifest;
  const membership = await verifyBaseMembership(
    membershipCredential,
    trustPolicy,
    genesis.creatorMemberKey,
  );
  let previous = null,
    previousDigest = null;
  for (let i = 0; i < chain.length; i++) {
    const signed = await verifySignedRegistration(chain[i]),
      current = signed.manifest;
    if (
      current.revision !== i ||
      current.previousManifestDigest !== previousDigest
    )
      throw new RegistrationError(
        "conflict",
        "Registration chain is not contiguous",
      );
    if (i === 0) {
      if (
        signed.signerMemberKey !== current.creatorMemberKey ||
        current.controllerMemberKey !== current.creatorMemberKey
      )
        throw new RegistrationError(
          "unauthorized",
          "Genesis must be signed and controlled by its creator",
        );
    } else {
      for (const field of [
        "entityRef",
        "entityClass",
        "creatorMemberKey",
        "genesisNonce",
        "namespaceId",
        "initialWorkspaceId",
      ])
        if (current[field] !== genesis[field])
          throw new RegistrationError(
            "invalid",
            "Immutable registration identity changed",
          );
      if (signed.signerMemberKey !== previous.controllerMemberKey)
        throw new RegistrationError(
          "unauthorized",
          "Update must be signed by the current controller",
        );
    }
    previous = current;
    previousDigest = await registrationManifestDigest(current);
  }
  const state = {
    chain,
    membershipCredential: membership,
    manifest: chain.at(-1).manifest,
    manifestDigest: previousDigest,
    genesisDigest: await registrationManifestDigest(genesis),
  };
  const result = Object.freeze({
    manifest: state.manifest,
    manifestDigest: state.manifestDigest,
    genesisDigest: state.genesisDigest,
  });
  verified.set(result, state);
  return result;
}
/** Internal opaque verification result; caller-created lookalikes are rejected. */
export function verifiedRegistrationState(value) {
  const state = verified.get(value);
  if (!state)
    throw new RegistrationError(
      "unauthorized",
      "A verified registration chain is required",
    );
  return structuredClone(state);
}
function origin(value) {
  if (typeof value !== "string")
    throw new RegistrationError("invalid", "Invalid origin");
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new RegistrationError("invalid", "Invalid origin");
  }
  if (
    url.origin !== value ||
    (url.protocol !== "https:" &&
      !(
        url.protocol === "http:" &&
        ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
      ))
  )
    throw new RegistrationError("invalid", "Origin must be HTTPS or loopback");
  return value;
}
export function parseRegistrationConsent(value) {
  exact(
    value,
    [
      "requestId",
      "origin",
      "audience",
      "nonce",
      "issuedAtMs",
      "expiresAtMs",
      "manifestDigest",
    ],
    "registration consent",
  );
  if (
    typeof value.requestId !== "string" ||
    !/^[A-Za-z0-9_-]{16,128}$/u.test(value.requestId)
  )
    throw new RegistrationError("invalid", "Invalid request ID");
  const result = {
    requestId: value.requestId,
    origin: origin(value.origin),
    audience: origin(value.audience),
    nonce: hex32(value.nonce),
    issuedAtMs: value.issuedAtMs,
    expiresAtMs: value.expiresAtMs,
    manifestDigest: hex32(value.manifestDigest),
  };
  if (
    !Number.isSafeInteger(result.issuedAtMs) ||
    result.issuedAtMs < 0 ||
    !Number.isSafeInteger(result.expiresAtMs) ||
    result.expiresAtMs <= result.issuedAtMs ||
    result.expiresAtMs - result.issuedAtMs > MAX_CONSENT_DURATION_MS
  )
    throw new RegistrationError("invalid", "Invalid consent lifetime");
  return Object.freeze(result);
}
export async function validateRegistrationRequest(value, context) {
  exact(value, ["manifest", "consent"], "registration request");
  const manifest = await validateRegistrationIdentity(value.manifest),
    consent = parseRegistrationConsent(value.consent);
  if (
    consent.origin !== context.origin ||
    consent.audience !== context.audience ||
    !Number.isSafeInteger(context.nowMs) ||
    consent.issuedAtMs > context.nowMs ||
    consent.expiresAtMs <= context.nowMs ||
    consent.manifestDigest !== (await registrationManifestDigest(manifest))
  )
    throw new RegistrationError(
      "unauthorized",
      "Registration consent binding or deadline failed",
    );
  return Object.freeze({ manifest, consent });
}
