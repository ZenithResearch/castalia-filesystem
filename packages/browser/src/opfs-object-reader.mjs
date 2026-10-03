// Derived from Castalia Web; source license unresolved. See provenance/browser-extraction.json.
export class ObjectReadError extends Error {
  code;
  constructor(code) {
    super(code);
    this.code = code;
    this.name = "ObjectReadError";
  }
}
const CONTENT_ID = /^[0-9a-f]{64}$/u;
const MAX_CALLBACK_BYTES = 4 * 1024 * 1024;
/**
 * `root/objects/aa/<content-id>` is an origin-private, immutable CAS layout.
 * The callback enforces the Rust-requested cap using File.size before it calls
 * arrayBuffer; Rust checks the returned length and hash again. No content
 * leaves this Worker unless the caller explicitly requests a bounded read.
 */
export function createOpfsObjectReader(root) {
  return async (id, maxBytes) => {
    if (
      !CONTENT_ID.test(id) ||
      !Number.isSafeInteger(maxBytes) ||
      maxBytes < 0 ||
      maxBytes > MAX_CALLBACK_BYTES
    ) {
      throw new ObjectReadError("invalid-request");
    }
    let handle;
    try {
      const objects = await root.getDirectoryHandle("objects");
      const prefix = await objects.getDirectoryHandle(id.slice(0, 2));
      handle = await prefix.getFileHandle(id);
    } catch (error) {
      if (error instanceof DOMException && error.name === "NotFoundError")
        throw new ObjectReadError("missing-object");
      throw new ObjectReadError("storage-unavailable");
    }
    let file;
    try {
      file = await handle.getFile();
    } catch {
      throw new ObjectReadError("storage-unavailable");
    }
    if (file.size > maxBytes) throw new ObjectReadError("oversized-object");
    let bytes;
    try {
      bytes = new Uint8Array(await file.arrayBuffer());
    } catch {
      throw new ObjectReadError("storage-unavailable");
    }
    if (bytes.byteLength > maxBytes)
      throw new ObjectReadError("oversized-object");
    return bytes;
  };
}
export async function openOpfsObjectReader() {
  if (
    !("storage" in navigator) ||
    typeof navigator.storage.getDirectory !== "function"
  )
    throw new ObjectReadError("storage-unavailable");
  try {
    return createOpfsObjectReader(await navigator.storage.getDirectory());
  } catch {
    throw new ObjectReadError("storage-unavailable");
  }
}
