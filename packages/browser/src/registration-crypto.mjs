// SPDX-License-Identifier: AGPL-3.0-or-later
import { hex32, RegistrationError } from "./address.mjs";
export function bytesFromHex(value) {
  return Uint8Array.from(hex32(value).match(/../gu), (x) =>
    Number.parseInt(x, 16),
  );
}
export function signatureBytes(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{86}$/u.test(value))
    throw new RegistrationError("invalid", "Invalid Ed25519 signature");
  const result = Uint8Array.from(
    atob(value.replace(/-/gu, "+").replace(/_/gu, "/") + "=="),
    (c) => c.charCodeAt(0),
  );
  const canonical = btoa(String.fromCharCode(...result))
    .replace(/\+/gu, "-")
    .replace(/\//gu, "_")
    .replace(/=+$/u, "");
  if (canonical !== value || result.length !== 64)
    throw new RegistrationError("invalid", "Noncanonical Ed25519 signature");
  return result;
}
export async function sha256(bytes) {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
}
export async function verifyEd25519(publicKey, signature, bytes) {
  const key = await globalThis.crypto.subtle.importKey(
    "raw",
    bytesFromHex(publicKey),
    { name: "Ed25519" },
    false,
    ["verify"],
  );
  if (
    !(await globalThis.crypto.subtle.verify(
      { name: "Ed25519" },
      key,
      signatureBytes(signature),
      bytes,
    ))
  )
    throw new RegistrationError("invalid-signature");
}
