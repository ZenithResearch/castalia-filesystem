// SPDX-License-Identifier: AGPL-3.0-or-later
// Additive Files shipping contracts. Existing snapshot/custody/Auth bytes stay unchanged.
const encoder = new TextEncoder();
export const FILES_KEY_PROTOCOL = "castalia.files-key-wrap.v1";
export const SHIPPING_LIMITS = Object.freeze({
  plaintextBytes: 128 * 1024 * 1024,
  ciphertextBytes: 128 * 1024 * 1024 + 16,
  partBytes: 8 * 1024 * 1024,
  headerBytes: 1024 * 1024,
  objects: 250000,
});
export class ShippingError extends Error {
  constructor(code, message = code) {
    super(message);
    this.name = "ShippingError";
    this.code = code;
  }
}
export function exactObject(value, keys, label = "record") {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value)) ||
    Object.keys(value).length !== keys.length ||
    keys.some((k) => !Object.hasOwn(value, k))
  )
    throw new ShippingError("invalid", `Invalid ${label}`);
}
export function hexId(value) {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/u.test(value))
    throw new ShippingError("invalid", "Expected a 32-byte identifier");
  return value;
}
export function base64url(bytes) {
  let text = "";
  for (let i = 0; i < bytes.length; i += 8192)
    text += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(text)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}
export function decodeBase64url(value, length) {
  if (
    typeof value !== "string" ||
    value.length > 1024 * 1024 ||
    !/^[A-Za-z0-9_-]*$/u.test(value) ||
    value.length % 4 === 1
  )
    throw new ShippingError("invalid", "Invalid base64url");
  let bytes;
  try {
    bytes = Uint8Array.from(
      atob(value.replaceAll("-", "+").replaceAll("_", "/")),
      (c) => c.charCodeAt(0),
    );
  } catch {
    throw new ShippingError("invalid", "Invalid base64url");
  }
  if (
    (length !== undefined && bytes.length !== length) ||
    base64url(bytes) !== value
  )
    throw new ShippingError("invalid", "Noncanonical base64url");
  return bytes;
}
export function parseFilesKeyBinding(value) {
  const keys = [
    "schema",
    "ownerMemberKey",
    "serviceId",
    "storageAccountId",
    "namespaceId",
    "workspaceId",
    "submissionId",
    "revisionId",
  ];
  exactObject(value, keys, "Files key binding");
  if (
    value.schema !== "castalia.files-key-binding.v1" ||
    typeof value.storageAccountId !== "string" ||
    !/^[A-Za-z0-9._~-]{1,128}$/u.test(value.storageAccountId)
  )
    throw new ShippingError("invalid", "Unsupported Files key binding");
  return Object.freeze({
    schema: value.schema,
    ownerMemberKey: hexId(value.ownerMemberKey),
    serviceId: hexId(value.serviceId),
    storageAccountId: value.storageAccountId,
    namespaceId: hexId(value.namespaceId),
    workspaceId: hexId(value.workspaceId),
    submissionId: hexId(value.submissionId),
    revisionId: hexId(value.revisionId),
  });
}
export function canonicalBindingBytes(value) {
  return encoder.encode(JSON.stringify(parseFilesKeyBinding(value)));
}
export function parseFilesKeyEnvelope(value) {
  exactObject(
    value,
    ["schema", "binding", "nonce", "ciphertext"],
    "Files key envelope",
  );
  if (value.schema !== "castalia.files-key-envelope.v1")
    throw new ShippingError("invalid", "Unsupported key envelope");
  decodeBase64url(value.nonce, 12);
  decodeBase64url(value.ciphertext, 48);
  return Object.freeze({
    schema: value.schema,
    binding: parseFilesKeyBinding(value.binding),
    nonce: value.nonce,
    ciphertext: value.ciphertext,
  });
}
export function canonicalJson(value) {
  let nodes = 0;
  function normalize(v, depth) {
    if (++nodes > 100000 || depth > 32) throw new ShippingError("limit");
    if (v === null || typeof v === "boolean") return v;
    if (typeof v === "string") {
      if (
        v.length > 1024 * 1024 ||
        /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(
          v,
        )
      )
        throw new ShippingError("invalid");
      return v;
    }
    if (typeof v === "number" && Number.isSafeInteger(v) && !Object.is(v, -0))
      return v;
    if (Array.isArray(v)) return v.map((x) => normalize(x, depth + 1));
    if (
      v &&
      typeof v === "object" &&
      [Object.prototype, null].includes(Object.getPrototypeOf(v))
    ) {
      const result = Object.create(null);
      for (const k of Object.keys(v).sort()) {
        if (["__proto__", "constructor", "prototype"].includes(k))
          throw new ShippingError("invalid");
        result[k] = normalize(v[k], depth + 1);
      }
      return result;
    }
    throw new ShippingError("invalid", "Unsupported canonical value");
  }
  return JSON.stringify(normalize(value, 0));
}
export function authChallengeBytes(value) {
  const keys = [
    "audience",
    "domain",
    "expiresAt",
    "issuedAt",
    "nonce",
    "operation",
    "origin",
    "version",
  ];
  exactObject(value, keys, "Auth challenge");
  if (
    value.domain !== "castalia-wallet" ||
    value.version !== 1 ||
    value.operation !== "castalia.wallet.signChallenge" ||
    !/^castalia-files:\/\/(index|gateway)\/[0-9a-f]{64}$/u.test(
      value.audience,
    ) ||
    typeof value.nonce !== "string" ||
    !/^[A-Za-z0-9_-]{16,128}$/u.test(value.nonce)
  )
    throw new ShippingError("invalid", "Unsupported Files authentication");
  let origin;
  try {
    origin = new URL(value.origin);
  } catch {
    throw new ShippingError("invalid");
  }
  if (
    origin.origin !== value.origin ||
    (origin.protocol !== "https:" &&
      !(
        origin.protocol === "http:" &&
        ["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname)
      ))
  )
    throw new ShippingError("invalid");
  for (const field of ["issuedAt", "expiresAt"])
    if (
      typeof value[field] !== "string" ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value[field]) ||
      Date.parse(value[field]) < 0 ||
      !Number.isFinite(Date.parse(value[field])) ||
      new Date(value[field]).toISOString() !== value[field]
    )
      throw new ShippingError("invalid");
  const duration = Date.parse(value.expiresAt) - Date.parse(value.issuedAt);
  if (duration <= 0 || duration > 120000) throw new ShippingError("invalid");
  return encoder.encode(
    JSON.stringify(Object.fromEntries(keys.map((k) => [k, value[k]]))),
  );
}
export async function sha256Hex(bytes) {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
    .map((v) => v.toString(16).padStart(2, "0"))
    .join("");
}
export function randomId() {
  return [...crypto.getRandomValues(new Uint8Array(32))]
    .map((v) => v.toString(16).padStart(2, "0"))
    .join("");
}
export function assertSameBinding(a, b) {
  if (
    JSON.stringify(parseFilesKeyBinding(a)) !==
    JSON.stringify(parseFilesKeyBinding(b))
  )
    throw new ShippingError("binding-mismatch");
}
export async function encryptShipment(
  bytes,
  keyBytes,
  binding,
  nonce = crypto.getRandomValues(new Uint8Array(12)),
) {
  if (
    !(bytes instanceof Uint8Array) ||
    bytes.length > SHIPPING_LIMITS.plaintextBytes ||
    !(keyBytes instanceof Uint8Array) ||
    keyBytes.length !== 32 ||
    nonce.length !== 12
  )
    throw new ShippingError("limit");
  const key = await crypto.subtle.importKey("raw", keyBytes, "AES-GCM", false, [
    "encrypt",
  ]);
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      {
        name: "AES-GCM",
        iv: nonce,
        additionalData: canonicalBindingBytes(binding),
        tagLength: 128,
      },
      key,
      bytes,
    ),
  );
  return {
    nonce: base64url(nonce),
    ciphertext,
    ciphertextSha256: await sha256Hex(ciphertext),
  };
}
export async function decryptShipment(ciphertext, keyBytes, binding, nonce) {
  if (
    !(ciphertext instanceof Uint8Array) ||
    ciphertext.length < 16 ||
    ciphertext.length > SHIPPING_LIMITS.ciphertextBytes ||
    !(keyBytes instanceof Uint8Array) ||
    keyBytes.length !== 32
  )
    throw new ShippingError("limit");
  const key = await crypto.subtle.importKey("raw", keyBytes, "AES-GCM", false, [
    "decrypt",
  ]);
  try {
    return new Uint8Array(
      await crypto.subtle.decrypt(
        {
          name: "AES-GCM",
          iv: decodeBase64url(nonce, 12),
          additionalData: canonicalBindingBytes(binding),
          tagLength: 128,
        },
        key,
        ciphertext,
      ),
    );
  } catch {
    throw new ShippingError("integrity", "Shipment authentication failed");
  }
}
