import type { FilesystemClient } from "./index.mjs";
import type {
  FilesWrapRequestV1,
  FilesUnwrapRequestV1,
  FilesServiceAuthRequestV1,
  FilesSignaturePresentationV1,
} from "./files-key-contract.mjs";
import type {
  BaseMembershipTrustPolicyV1,
  SignedRegistrationManifestV1,
} from "./registration.mjs";
export type FilesKeyBindingV1 = Readonly<{
  schema: "castalia.files-key-binding.v1";
  ownerMemberKey: string;
  serviceId: string;
  storageAccountId: string;
  namespaceId: string;
  workspaceId: string;
  submissionId: string;
  revisionId: string;
}>;
export type FilesKeyEnvelopeV1 = Readonly<{
  schema: "castalia.files-key-envelope.v1";
  binding: FilesKeyBindingV1;
  nonce: string;
  ciphertext: string;
}>;
export type ShippingStatus =
  | "Local only"
  | "Shipping"
  | "Shipped"
  | "Local changes"
  | "Failed";
export interface StorageConnection {
  gatewayUrl: string;
  gatewayId: string;
  storageAccountId: string;
  providerName: string;
  termsUrl: string;
  budgetBytes: number;
}
export interface ShippingConfig {
  indexUrl: string;
  serviceId: string;
  membershipTrustPolicy: BaseMembershipTrustPolicyV1;
  connection?: StorageConnection;
  createCryptoWorker: () => Worker;
  verifyShipment: (blob: Blob) => Promise<{
    root: string;
    path: string | null;
    kind: "file" | "workspace";
  }>;
}
export interface FilesKeyProvider {
  readonly filesKeyProtocol?: string;
  getSubject(): Promise<{
    dreggOwnerPublicKey?: string;
    memberKey?: string;
    subjectId?: string;
  }>;
  wrapFilesKey(input: FilesWrapRequestV1): Promise<FilesKeyEnvelopeV1>;
  unwrapFilesKey(input: FilesUnwrapRequestV1): Promise<{ key: string }>;
  requestFilesServiceAuthentication(
    input: FilesServiceAuthRequestV1,
  ): Promise<FilesSignaturePresentationV1>;
}
export interface ShippingDestination {
  entityRef: string;
  entityClass: string;
  displayName: string;
  namespaceId: string;
  workspaceId: string;
  registrationGenesisDigest: string;
  controllerMemberKey: string;
  canonicalAlias?: "zenith";
  canSubmit?: boolean;
  canUpdateOwn?: boolean;
}
export interface ShippingIdentity {
  ownerMemberKey: string;
  personalNamespace: ShippingDestination | null;
  connection: StorageConnection | null;
}
export interface ShippingSource {
  filesystem: FilesystemClient;
  root: string;
  path?: string;
}
export interface ShippingRecord {
  operationId: string;
  binding: FilesKeyBindingV1;
  sourceRoot: string;
  sourcePath: string | null;
  status: ShippingStatus;
  detail: string;
  updatedAt: string;
  receipt?: unknown;
  error?: string;
}
export interface RemoteSubmission {
  submissionId: string;
  revisionId: string;
  namespaceId: string;
  workspaceId: string;
  ownerMemberKey: string;
  withdrawn: boolean;
  receipt: unknown;
}
export interface RetrievedShipment {
  blob: Blob;
  submission: RemoteSubmission;
  sourceRoot: string;
  sourcePath: string | null;
}
export interface ShippingSession {
  connect(): Promise<ShippingIdentity>;
  personalNamespace(): Promise<ShippingDestination | null>;
  saveConnection(connection: StorageConnection): Promise<void>;
  acceptRegistration(
    chain: SignedRegistrationManifestV1[],
    membershipCredential: unknown,
  ): Promise<ShippingDestination>;
  destinations(): Promise<ShippingDestination[]>;
  listOwn(): Promise<RemoteSubmission[]>;
  ship(input: {
    source: ShippingSource;
    destination?: ShippingDestination;
    submissionId?: string;
    previousRevisionId?: string | null;
    signal?: AbortSignal;
  }): Promise<ShippingRecord>;
  resume(operationId: string, signal?: AbortSignal): Promise<ShippingRecord>;
  retrieve(
    submissionId: string,
    revisionId?: string,
    signal?: AbortSignal,
  ): Promise<RetrievedShipment>;
  withdraw(submissionId: string): Promise<void>;
  operations(): Promise<ShippingRecord[]>;
  observe(listener: (record: ShippingRecord) => void): () => void;
  currentStatus(record: ShippingRecord, sourceRoot: string): ShippingStatus;
  dispose(): void;
}
export function parseShippingConfig(value: unknown): ShippingConfig;
export function openShippingSession(
  config: ShippingConfig,
  provider: FilesKeyProvider,
): ShippingSession;
