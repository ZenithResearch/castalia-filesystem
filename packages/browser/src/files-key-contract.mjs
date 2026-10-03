export const FILES_KEY_PROTOCOL = 'castalia.files-key-wrap.v1';
function invalid() { throw new Error('Invalid Files custody request'); }
function exact(value, keys) {
    if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))
        || Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key)))
        invalid();
}
function hex(value) { if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value))
    invalid(); return value; }
function boundedId(value) { if (typeof value !== 'string' || !/^[A-Za-z0-9._~-]{1,128}$/.test(value))
    invalid(); return value; }
export function filesBase64url(bytes) { return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
export function filesDecodeKey(value, length = 32) {
    if (typeof value !== 'string' || value.length > 128 || !/^[A-Za-z0-9_-]+$/.test(value))
        invalid();
    let bytes;
    try {
        bytes = Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/')), char => char.charCodeAt(0));
    }
    catch {
        invalid();
    }
    if (bytes.length !== length || filesBase64url(bytes) !== value)
        invalid();
    return bytes;
}
export function parseFilesKeyBinding(value) {
    exact(value, ['schema', 'ownerMemberKey', 'serviceId', 'storageAccountId', 'namespaceId', 'workspaceId', 'submissionId', 'revisionId']);
    if (value.schema !== 'castalia.files-key-binding.v1')
        invalid();
    return Object.freeze({ schema: value.schema, ownerMemberKey: hex(value.ownerMemberKey), serviceId: hex(value.serviceId),
        storageAccountId: boundedId(value.storageAccountId), namespaceId: hex(value.namespaceId), workspaceId: hex(value.workspaceId),
        submissionId: hex(value.submissionId), revisionId: hex(value.revisionId) });
}
export function parseFilesKeyEnvelope(value) {
    exact(value, ['schema', 'binding', 'nonce', 'ciphertext']);
    if (value.schema !== 'castalia.files-key-envelope.v1')
        invalid();
    filesDecodeKey(value.nonce, 12);
    filesDecodeKey(value.ciphertext, 48);
    return Object.freeze({ schema: value.schema, binding: parseFilesKeyBinding(value.binding), nonce: value.nonce, ciphertext: value.ciphertext });
}
export function filesWebOrigin(value) {
    if (typeof value !== 'string')
        invalid();
    let url;
    try {
        url = new URL(value);
    }
    catch {
        invalid();
    }
    if (url.origin !== value || (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))))
        invalid();
    return value;
}
export function filesAudience(kind, serviceId) {
    if (!['index', 'gateway'].includes(kind))
        invalid();
    return `castalia-files://${kind}/${hex(serviceId)}`;
}
function challenge(value, kind, serviceId) {
    exact(value, ['audience', 'domain', 'expiresAt', 'issuedAt', 'nonce', 'operation', 'origin', 'version']);
    if (value.audience !== filesAudience(kind, serviceId) || value.domain !== 'castalia-wallet' || value.version !== 1
        || value.operation !== 'castalia.wallet.signChallenge' || typeof value.nonce !== 'string' || !/^[A-Za-z0-9_-]{16,128}$/.test(value.nonce))
        invalid();
    for (const field of ['issuedAt', 'expiresAt']) {
        const date = value[field];
        if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(date)
            || !Number.isFinite(Date.parse(date)) || Date.parse(date) < 0 || new Date(date).toISOString() !== date)
            invalid();
    }
    const issuedAt = value.issuedAt, expiresAt = value.expiresAt;
    if (Date.parse(expiresAt) <= Date.parse(issuedAt) || Date.parse(expiresAt) - Date.parse(issuedAt) > 120_000)
        invalid();
    return Object.freeze({ audience: value.audience, domain: value.domain, expiresAt, issuedAt, nonce: value.nonce,
        operation: value.operation, origin: filesWebOrigin(value.origin), version: value.version });
}
export function parseFilesBody(operation, value) {
    if (operation === 'wrap') {
        exact(value, ['binding', 'key']);
        filesDecodeKey(value.key);
        return Object.freeze({ binding: parseFilesKeyBinding(value.binding), key: value.key });
    }
    if (operation === 'unwrap') {
        exact(value, ['binding', 'envelope']);
        const binding = parseFilesKeyBinding(value.binding), envelope = parseFilesKeyEnvelope(value.envelope);
        if (JSON.stringify(binding) !== JSON.stringify(envelope.binding))
            invalid();
        return Object.freeze({ binding, envelope });
    }
    if (operation === 'authenticate') {
        exact(value, ['serviceKind', 'serviceId', 'challenge']);
        if (value.serviceKind !== 'index' && value.serviceKind !== 'gateway')
            invalid();
        const serviceId = hex(value.serviceId);
        return Object.freeze({ serviceKind: value.serviceKind, serviceId, challenge: challenge(value.challenge, value.serviceKind, serviceId) });
    }
    return invalid();
}
export async function filesRequestDigest(operation, body) {
    const normalized = parseFilesBody(operation, body);
    const bytes = new TextEncoder().encode('castalia/files-key-request/v1\0' + JSON.stringify({ operation, body: normalized }));
    return Array.from(new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', bytes)), byte => byte.toString(16).padStart(2, '0')).join('');
}
function randomHex() { return Array.from(globalThis.crypto.getRandomValues(new Uint8Array(32)), byte => byte.toString(16).padStart(2, '0')).join(''); }
export async function buildFilesConsent(operation, body, origin, options = {}) {
    const normalized = parseFilesBody(operation, body);
    const issuedAtMs = options.nowMs ?? Date.now(), ttlMs = options.ttlMs ?? 120_000;
    if (!Number.isSafeInteger(issuedAtMs) || issuedAtMs < 0 || !Number.isSafeInteger(ttlMs) || ttlMs <= 0 || ttlMs > 120_000 || !Number.isSafeInteger(issuedAtMs + ttlMs))
        invalid();
    const audience = 'binding' in normalized ? filesAudience('index', normalized.binding.serviceId) : filesAudience(normalized.serviceKind, normalized.serviceId);
    return Object.freeze({ requestId: randomHex(), origin: filesWebOrigin(origin), audience, nonce: randomHex(), issuedAtMs,
        expiresAtMs: issuedAtMs + ttlMs, requestDigest: await filesRequestDigest(operation, normalized) });
}
export function parseFilesConsent(value) {
    exact(value, ['requestId', 'origin', 'audience', 'nonce', 'issuedAtMs', 'expiresAtMs', 'requestDigest']);
    if (typeof value.audience !== 'string' || !/^castalia-files:\/\/(index|gateway)\/[0-9a-f]{64}$/.test(value.audience)
        || !Number.isSafeInteger(value.issuedAtMs) || !Number.isSafeInteger(value.expiresAtMs))
        invalid();
    const issuedAtMs = value.issuedAtMs, expiresAtMs = value.expiresAtMs;
    if (issuedAtMs < 0 || expiresAtMs <= issuedAtMs || expiresAtMs - issuedAtMs > 120_000)
        invalid();
    return Object.freeze({ requestId: boundedId(value.requestId), origin: filesWebOrigin(value.origin), audience: value.audience,
        nonce: hex(value.nonce), issuedAtMs, expiresAtMs, requestDigest: hex(value.requestDigest) });
}
export async function validateFilesRequest(operation, value, expected) {
    const keys = operation === 'wrap' ? ['binding', 'key', 'consent'] : operation === 'unwrap' ? ['binding', 'envelope', 'consent'] : ['serviceKind', 'serviceId', 'challenge', 'consent'];
    exact(value, keys);
    const body = parseFilesBody(operation, Object.fromEntries(keys.filter(key => key !== 'consent').map(key => [key, value[key]])));
    const consent = parseFilesConsent(value.consent);
    const audience = 'binding' in body ? filesAudience('index', body.binding.serviceId) : filesAudience(body.serviceKind, body.serviceId);
    if (consent.origin !== filesWebOrigin(expected.origin) || consent.audience !== audience
        || !Number.isSafeInteger(expected.nowMs) || expected.nowMs < consent.issuedAtMs || expected.nowMs >= consent.expiresAtMs
        || consent.requestDigest !== await filesRequestDigest(operation, body))
        invalid();
    if ('challenge' in body && (body.challenge.origin !== expected.origin || expected.nowMs < Date.parse(body.challenge.issuedAt)
        || expected.nowMs >= Date.parse(body.challenge.expiresAt)))
        invalid();
    return Object.freeze({ ...body, consent });
}
