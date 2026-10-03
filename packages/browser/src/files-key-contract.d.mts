export declare const FILES_KEY_PROTOCOL: "castalia.files-key-wrap.v1";
export type FilesKeyBindingV1 = Readonly<{
    schema: 'castalia.files-key-binding.v1';
    ownerMemberKey: string;
    serviceId: string;
    storageAccountId: string;
    namespaceId: string;
    workspaceId: string;
    submissionId: string;
    revisionId: string;
}>;
export type FilesKeyEnvelopeV1 = Readonly<{
    schema: 'castalia.files-key-envelope.v1';
    binding: FilesKeyBindingV1;
    nonce: string;
    ciphertext: string;
}>;
export type FilesKeyConsentV1 = Readonly<{
    requestId: string;
    origin: string;
    audience: string;
    nonce: string;
    issuedAtMs: number;
    expiresAtMs: number;
    requestDigest: string;
}>;
export type FilesServiceAuthChallengeV1 = Readonly<{
    audience: string;
    domain: 'castalia-wallet';
    expiresAt: string;
    issuedAt: string;
    nonce: string;
    operation: 'castalia.wallet.signChallenge';
    origin: string;
    version: 1;
}>;
export type FilesWrapBodyV1 = Readonly<{
    binding: FilesKeyBindingV1;
    key: string;
}>;
export type FilesUnwrapBodyV1 = Readonly<{
    binding: FilesKeyBindingV1;
    envelope: FilesKeyEnvelopeV1;
}>;
export type FilesServiceAuthBodyV1 = Readonly<{
    serviceKind: 'index' | 'gateway';
    serviceId: string;
    challenge: FilesServiceAuthChallengeV1;
}>;
export type FilesWrapRequestV1 = FilesWrapBodyV1 & {
    consent: FilesKeyConsentV1;
};
export type FilesUnwrapRequestV1 = FilesUnwrapBodyV1 & {
    consent: FilesKeyConsentV1;
};
export type FilesServiceAuthRequestV1 = FilesServiceAuthBodyV1 & {
    consent: FilesKeyConsentV1;
};
export type FilesOperationV1 = 'wrap' | 'unwrap' | 'authenticate';
export type FilesRequestV1 = FilesWrapRequestV1 | FilesUnwrapRequestV1 | FilesServiceAuthRequestV1;
export type FilesSignaturePresentationV1 = {
    subject: {
        subjectId: string;
        publicKey: string;
        walletKind: 'castalia-dregg';
        dreggOwnerPublicKey?: string;
    };
    challenge: FilesServiceAuthChallengeV1;
    signature: string;
    signatureAlgorithm: 'ed25519';
};
export interface FilesKeyProviderV1 {
    readonly filesKeyProtocol: typeof FILES_KEY_PROTOCOL;
    wrapFilesKey(request: FilesWrapRequestV1): Promise<FilesKeyEnvelopeV1>;
    unwrapFilesKey(request: FilesUnwrapRequestV1): Promise<{
        key: string;
    }>;
    requestFilesServiceAuthentication(request: FilesServiceAuthRequestV1): Promise<FilesSignaturePresentationV1>;
}
export declare function filesBase64url(bytes: Uint8Array): string;
export declare function filesDecodeKey(value: unknown, length?: number): Uint8Array;
export declare function parseFilesKeyBinding(value: unknown): FilesKeyBindingV1;
export declare function parseFilesKeyEnvelope(value: unknown): FilesKeyEnvelopeV1;
export declare function filesWebOrigin(value: unknown): string;
export declare function filesAudience(kind: 'index' | 'gateway', serviceId: string): string;
export declare function parseFilesBody(operation: FilesOperationV1, value: unknown): FilesWrapBodyV1 | FilesUnwrapBodyV1 | FilesServiceAuthBodyV1;
export declare function filesRequestDigest(operation: FilesOperationV1, body: unknown): Promise<string>;
export declare function buildFilesConsent(operation: FilesOperationV1, body: unknown, origin: string, options?: {
    nowMs?: number;
    ttlMs?: number;
}): Promise<FilesKeyConsentV1>;
export declare function parseFilesConsent(value: unknown): FilesKeyConsentV1;
export declare function validateFilesRequest(operation: FilesOperationV1, value: unknown, expected: {
    origin: string;
    nowMs: number;
}): Promise<FilesRequestV1>;
