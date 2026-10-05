export type MemberKey = string;
export interface RegistrationManifestV1 {
  schema: "castalia.namespace-registration.v1";
  entityRef: string;
  entityClass:
    | "https://zenith-research.ca/ontology/terms/Person"
    | "https://zenith-research.ca/ontology/terms/Organization";
  creatorMemberKey: MemberKey;
  genesisNonce: string;
  namespaceId: string;
  initialWorkspaceId: string;
  controllerMemberKey: MemberKey;
  displayName: string;
  revision: number;
  previousManifestDigest: string | null;
}
export interface RegistrationConsentV1 {
  requestId: string;
  origin: string;
  audience: string;
  nonce: string;
  issuedAtMs: number;
  expiresAtMs: number;
  manifestDigest: string;
}
export interface RegistrationRequestV1 {
  manifest: RegistrationManifestV1;
  consent: RegistrationConsentV1;
}
export interface SignedRegistrationManifestV1 {
  schema: "castalia.signed-namespace-registration.v1";
  manifest: RegistrationManifestV1;
  signerMemberKey: MemberKey;
  signatureSuite: "Ed25519";
  signature: string;
}
/** Existing member custody; no provider brand, new key, or login transcript. */
export interface RegistrationProvider {
  requestRegistration(
    input: RegistrationRequestV1,
  ): Promise<SignedRegistrationManifestV1>;
}
export interface BaseMembershipCredentialV3 {
  schema: "castalia.zenith-membership-credential.v3";
  version: 3;
  membershipId: string;
  ownerPublicKey: MemberKey;
  status: "active";
  issuerId: string;
  issuerKeyId: string;
  signatureSuite: "Ed25519";
  issuerSignature: string;
}
export interface BaseMembershipTrustPolicyV1 {
  schema: "castalia.zenith-membership-trust-policy.v1";
  version: 1;
  roots: readonly {
    issuerId: string;
    keyId: string;
    signatureSuite: "Ed25519";
    publicKey: string;
  }[];
}
declare const verifiedBrand: unique symbol;
export interface VerifiedRegistration {
  readonly [verifiedBrand]: true;
  readonly manifest: Readonly<RegistrationManifestV1>;
  readonly manifestDigest: string;
  readonly genesisDigest: string;
}
export class RegistrationError extends Error {
  readonly code: string;
  constructor(code: string, message?: string);
}
export const REGISTRATION_SCHEMA: "castalia.namespace-registration.v1";
export const SIGNED_REGISTRATION_SCHEMA: "castalia.signed-namespace-registration.v1";
export const REGISTRATION_DOMAIN: "castalia/namespace-registration/v1\0";
export const PERSON_CLASS: "https://zenith-research.ca/ontology/terms/Person";
export const ORGANIZATION_CLASS: "https://zenith-research.ca/ontology/terms/Organization";
export const MAX_REGISTRATION_REVISIONS: 256;
export const MAX_CONSENT_DURATION_MS: 120000;
export function createRegistrationManifest(
  input: Pick<
    RegistrationManifestV1,
    | "entityClass"
    | "creatorMemberKey"
    | "genesisNonce"
    | "initialWorkspaceId"
    | "displayName"
  >,
): Promise<Readonly<RegistrationManifestV1>>;
export function parseRegistrationManifest(
  value: unknown,
): Readonly<RegistrationManifestV1>;
export function validateRegistrationIdentity(
  value: unknown,
): Promise<Readonly<RegistrationManifestV1>>;
export function registrationSigningBytes(value: unknown): Uint8Array;
export function registrationManifestDigest(value: unknown): Promise<string>;
export function parseSignedRegistration(
  value: unknown,
): Readonly<SignedRegistrationManifestV1>;
/** Signature/identity only; use chain verification to establish controller authority. */
export function verifySignedRegistration(
  value: unknown,
): Promise<Readonly<SignedRegistrationManifestV1>>;
export function verifyRegistrationChain(
  chain: unknown,
  options: {
    membershipCredential: unknown;
    trustPolicy: BaseMembershipTrustPolicyV1;
  },
): Promise<VerifiedRegistration>;
export function verifyBaseMembership(
  value: unknown,
  policy: BaseMembershipTrustPolicyV1,
  owner: MemberKey,
): Promise<BaseMembershipCredentialV3>;
export function parseRegistrationConsent(
  value: unknown,
): Readonly<RegistrationConsentV1>;
export function validateRegistrationRequest(
  value: unknown,
  context: { origin: string; audience: string; nowMs: number },
): Promise<Readonly<RegistrationRequestV1>>;
export function bytesFromHex(value: string): Uint8Array;
export function signatureBytes(value: string): Uint8Array;
export function sha256(bytes: Uint8Array): Promise<string>;
export function verifyEd25519(
  publicKey: string,
  signature: string,
  bytes: Uint8Array,
): Promise<void>;

/** Capability-detected additive transport; signatures are proposals, not receiver acceptance. */
export interface RegistrationProviderV2 {
  getCapabilities(): Promise<readonly string[]>;
  requestRegistrationV2(
    request: RegistrationRequestV1,
  ): Promise<SignedRegistrationManifestV1>;
}
