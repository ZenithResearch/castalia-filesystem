import type { FilesKeyBindingV1 } from "./shipping.mjs";
export interface SignedServiceEnvelope<T> {
  payload: T;
  keyId: string;
  signature: string;
}
export interface UploadIntent {
  schema: "castalia.files-upload-intent.v1";
  operationId: string;
  binding: FilesKeyBindingV1;
  registrationGenesisDigest: string;
  expectedRevisionId: string | null;
  ciphertextSha256: string;
  byteLength: number;
  gatewayId: string;
  issuedAt: string;
  expiresAt: string;
}
export interface StorageReceipt {
  schema: "castalia.files-storage-receipt.v1";
  operationId: string;
  ownerMemberKey: string;
  storageAccountId: string;
  gatewayId: string;
  objectKey: string;
  objectVersion: string;
  ciphertextSha256: string;
  byteLength: number;
  s3dRevision: string;
  pendingObjects: 0;
  unpinnedObjects: 0;
  verifiedAt: string;
}
export interface IndexAcceptance {
  schema: "castalia.files-index-acceptance.v1";
  operationId: string;
  ownerMemberKey: string;
  serviceId: string;
  namespaceId: string;
  workspaceId: string;
  registrationGenesisDigest: string;
  submissionId: string;
  revisionId: string;
  previousRevisionId: string | null;
  descriptorDigest: string;
  storageReceiptDigest: string;
  sequence: number;
  acceptedAt: string;
}
export interface NamespaceAcceptance {
  schema: "castalia.files-namespace-acceptance.v1";
  serviceId: string;
  manifestDigest: string;
  registrationGenesisDigest: string;
  namespaceId: string;
  workspaceId: string;
  entityRef: string;
  controllerMemberKey: string;
  acceptedAt: string;
}
export const S3D_REVISION: "e468d007cfc9eefa083d09b5a858ba294f64f6cf";
export const MAX_SHIPMENT_BYTES: number;
export const UPLOAD_PART_BYTES: number;
export function parseUploadIntent(value: unknown): Readonly<UploadIntent>;
export function parseStorageReceipt(value: unknown): Readonly<StorageReceipt>;
export function parseIndexAcceptance(value: unknown): Readonly<IndexAcceptance>;
export function parseNamespaceAcceptance(
  value: unknown,
): Readonly<NamespaceAcceptance>;
export function verifyServiceEnvelope<T>(
  value: unknown,
  keyId: string,
  parse: (value: unknown) => T,
): Promise<T>;
export function serviceEnvelopeDigest(value: unknown): Promise<string>;
