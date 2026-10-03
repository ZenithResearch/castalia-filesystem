// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  ShippingError,
  canonicalJson,
  parseFilesKeyBinding,
} from "./shipping-contract.mjs";
import { verifyEd25519, sha256 } from "./registration-crypto.mjs";
export const S3D_REVISION = "e468d007cfc9eefa083d09b5a858ba294f64f6cf";
export const MAX_SHIPMENT_BYTES = 128 * 1024 * 1024 + 16;
export const UPLOAD_PART_BYTES = 8 * 1024 * 1024;
const error = () => {
  throw new ShippingError("invalid-receipt", "Invalid Files service receipt");
};
function exact(v, keys) {
  if (
    !v ||
    typeof v !== "object" ||
    Array.isArray(v) ||
    Object.keys(v).sort().join("\0") !== keys.sort().join("\0")
  )
    error();
}
function hex(v) {
  if (typeof v !== "string" || !/^[a-f0-9]{64}$/.test(v)) error();
  return v;
}
function text(v, max = 1024) {
  if (
    typeof v !== "string" ||
    v.length < 1 ||
    v.length > max ||
    /[\p{Cc}\p{Cs}]/u.test(v)
  )
    error();
  return v;
}
function date(v) {
  if (
    typeof v !== "string" ||
    !Number.isFinite(Date.parse(v)) ||
    new Date(v).toISOString() !== v
  )
    error();
  return v;
}
function size(v) {
  if (!Number.isSafeInteger(v) || v < 16 || v > MAX_SHIPMENT_BYTES) error();
  return v;
}
function account(v) {
  if (typeof v !== "string" || !/^[A-Za-z0-9._~-]{1,128}$/.test(v)) error();
  return v;
}
export function parseUploadIntent(v) {
  exact(v, [
    "schema",
    "operationId",
    "binding",
    "registrationGenesisDigest",
    "expectedRevisionId",
    "ciphertextSha256",
    "byteLength",
    "gatewayId",
    "issuedAt",
    "expiresAt",
  ]);
  if (v.schema !== "castalia.files-upload-intent.v1") error();
  const result = {
    schema: v.schema,
    operationId: hex(v.operationId),
    binding: parseFilesKeyBinding(v.binding),
    registrationGenesisDigest: hex(v.registrationGenesisDigest),
    expectedRevisionId:
      v.expectedRevisionId === null ? null : hex(v.expectedRevisionId),
    ciphertextSha256: hex(v.ciphertextSha256),
    byteLength: size(v.byteLength),
    gatewayId: hex(v.gatewayId),
    issuedAt: date(v.issuedAt),
    expiresAt: date(v.expiresAt),
  };
  if (
    Date.parse(result.expiresAt) <= Date.parse(result.issuedAt) ||
    Date.parse(result.expiresAt) - Date.parse(result.issuedAt) > 24 * 3600000
  )
    error();
  return Object.freeze(result);
}
export function parseStorageReceipt(v) {
  exact(v, [
    "schema",
    "operationId",
    "ownerMemberKey",
    "storageAccountId",
    "gatewayId",
    "objectKey",
    "objectVersion",
    "ciphertextSha256",
    "byteLength",
    "s3dRevision",
    "pendingObjects",
    "unpinnedObjects",
    "verifiedAt",
  ]);
  if (
    v.schema !== "castalia.files-storage-receipt.v1" ||
    v.objectVersion === "null" ||
    v.s3dRevision !== S3D_REVISION ||
    v.pendingObjects !== 0 ||
    v.unpinnedObjects !== 0
  )
    error();
  return Object.freeze({
    schema: v.schema,
    operationId: hex(v.operationId),
    ownerMemberKey: hex(v.ownerMemberKey),
    storageAccountId: account(v.storageAccountId),
    gatewayId: hex(v.gatewayId),
    objectKey: text(v.objectKey),
    objectVersion: text(v.objectVersion),
    ciphertextSha256: hex(v.ciphertextSha256),
    byteLength: size(v.byteLength),
    s3dRevision: v.s3dRevision,
    pendingObjects: 0,
    unpinnedObjects: 0,
    verifiedAt: date(v.verifiedAt),
  });
}
export function parseIndexAcceptance(v) {
  exact(v, [
    "schema",
    "operationId",
    "ownerMemberKey",
    "serviceId",
    "namespaceId",
    "workspaceId",
    "registrationGenesisDigest",
    "submissionId",
    "revisionId",
    "previousRevisionId",
    "descriptorDigest",
    "storageReceiptDigest",
    "sequence",
    "acceptedAt",
  ]);
  if (
    v.schema !== "castalia.files-index-acceptance.v1" ||
    !Number.isSafeInteger(v.sequence) ||
    v.sequence < 1
  )
    error();
  return Object.freeze({
    schema: v.schema,
    operationId: hex(v.operationId),
    ownerMemberKey: hex(v.ownerMemberKey),
    serviceId: hex(v.serviceId),
    namespaceId: hex(v.namespaceId),
    workspaceId: hex(v.workspaceId),
    registrationGenesisDigest: hex(v.registrationGenesisDigest),
    submissionId: hex(v.submissionId),
    revisionId: hex(v.revisionId),
    previousRevisionId:
      v.previousRevisionId === null ? null : hex(v.previousRevisionId),
    descriptorDigest: hex(v.descriptorDigest),
    storageReceiptDigest: hex(v.storageReceiptDigest),
    sequence: v.sequence,
    acceptedAt: date(v.acceptedAt),
  });
}
export async function verifyServiceEnvelope(v, keyId, parse) {
  exact(v, ["payload", "signature", "keyId"]);
  if (v.keyId !== hex(keyId)) error();
  const payload = parse(v.payload);
  try {
    await verifyEd25519(
      keyId,
      v.signature,
      new TextEncoder().encode(canonicalJson(payload)),
    );
  } catch {
    error();
  }
  return payload;
}
export async function serviceEnvelopeDigest(v) {
  return sha256(new TextEncoder().encode(canonicalJson(v)));
}

export function parseNamespaceAcceptance(v) {
  exact(v, [
    "schema",
    "serviceId",
    "manifestDigest",
    "registrationGenesisDigest",
    "namespaceId",
    "workspaceId",
    "entityRef",
    "controllerMemberKey",
    "acceptedAt",
  ]);
  if (
    v.schema !== "castalia.files-namespace-acceptance.v1" ||
    typeof v.entityRef !== "string" ||
    !/^urn:castalia:entity:[a-f0-9]{64}$/.test(v.entityRef)
  )
    error();
  return Object.freeze({
    schema: v.schema,
    serviceId: hex(v.serviceId),
    manifestDigest: hex(v.manifestDigest),
    registrationGenesisDigest: hex(v.registrationGenesisDigest),
    namespaceId: hex(v.namespaceId),
    workspaceId: hex(v.workspaceId),
    entityRef: v.entityRef,
    controllerMemberKey: hex(v.controllerMemberKey),
    acceptedAt: date(v.acceptedAt),
  });
}
