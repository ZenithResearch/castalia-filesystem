import type {
  VerifiedRegistration,
  BaseMembershipTrustPolicyV1,
} from "./registration.mjs";
export interface WorkspaceAddress {
  namespaceId: string;
  workspaceId: string;
}
export interface NamespaceBinding {
  namespaceId: string;
  entityRef: string;
  registrationGenesisDigest: string;
}
export interface WorkspaceCatalog {
  schema: "castalia.browser-filesystem-catalog.v1";
  head: string;
  revisions: { root: string; committedMs: number }[];
}
export interface WorkspaceRow {
  schema: "castalia.filesystem-workspace.v1";
  address: WorkspaceAddress;
  entityRef: string;
  registrationGenesisDigest: string;
  catalog: WorkspaceCatalog;
}
export interface ReviewedMountEntry extends NamespaceBinding {
  canonicalPath: string;
}
export interface ReviewedManifestIndex {
  schema: "castalia.reviewed-namespace-index.v1";
  entries: ReviewedMountEntry[];
}
export function parseWorkspaceRow(value: unknown): WorkspaceRow;
export function parseReviewedManifestIndex(
  value: unknown,
): ReviewedManifestIndex;
export function loadRegistration(
  db: IDBDatabase,
  namespaceId: string,
  options: { trustPolicy: BaseMembershipTrustPolicyV1 },
): Promise<VerifiedRegistration | null>;
export function publishRegistration(
  db: IDBDatabase,
  registration: VerifiedRegistration,
  options?: {
    catalog?: WorkspaceCatalog;
    reviewedIndex?: ReviewedManifestIndex;
  },
): Promise<VerifiedRegistration>;
export function publishWorkspace(
  db: IDBDatabase,
  input: {
    registration: VerifiedRegistration;
    workspaceId: string;
    catalog: WorkspaceCatalog;
  },
): Promise<WorkspaceRow>;
export function acceptReviewedManifest(
  db: IDBDatabase,
  registration: VerifiedRegistration,
  reviewedIndex: ReviewedManifestIndex,
): Promise<ReviewedMountEntry>;
export function assertAcceptedNamespace(
  db: IDBDatabase,
  binding: NamespaceBinding,
  reviewedIndex: ReviewedManifestIndex,
  options: { trustPolicy: BaseMembershipTrustPolicyV1 },
): Promise<VerifiedRegistration>;

export interface AcceptedMount extends ReviewedMountEntry {
  registration: VerifiedRegistration;
}
export function publishAcceptedRegistration(
  db: IDBDatabase,
  registration: VerifiedRegistration,
  options: { catalog?: WorkspaceCatalog; reviewedIndex: ReviewedManifestIndex },
): Promise<VerifiedRegistration>;
export function listAcceptedMounts(
  db: IDBDatabase,
  reviewedIndex: ReviewedManifestIndex,
  options: { trustPolicy: BaseMembershipTrustPolicyV1 },
): Promise<AcceptedMount[]>;
export function resolveMount(
  db: IDBDatabase,
  canonicalPath: string,
  reviewedIndex: ReviewedManifestIndex,
  options: { trustPolicy: BaseMembershipTrustPolicyV1 },
): Promise<AcceptedMount | null>;
/** Local explicit acceptance, not independently authenticated registry-operator policy. */
export function loadLocalReviewedIndex(
  db: IDBDatabase,
): Promise<ReviewedManifestIndex>;
export function listWorkspaceRows(
  db: IDBDatabase,
  binding: NamespaceBinding,
): Promise<WorkspaceRow[]>;
