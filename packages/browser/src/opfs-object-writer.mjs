// Derived from Castalia Web; source license unresolved. See provenance/browser-extraction.json.
import { createOpfsObjectReader } from "./opfs-object-reader.mjs";
const MAX_OBJECT_BYTES = 1024 * 1024;
const ID = /^[0-9a-f]{64}$/u;
export class ObjectWriteError extends Error {
  code;
  constructor(code) {
    super(code);
    this.code = code;
    this.name = "ObjectWriteError";
  }
}
function equalBytes(left, right) {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1)
    if (left[index] !== right[index]) return false;
  return true;
}
function writeFailure(error) {
  return error instanceof DOMException && error.name === "QuotaExceededError"
    ? new ObjectWriteError("quota")
    : new ObjectWriteError("storage-unavailable");
}
/**
 * Acknowledges an immutable object only after close and a bounded reopen.
 * A partially staged or corrupt hash-named object cannot become a catalog root.
 */
export function createOpfsObjectWriter(root, contentId) {
  const read = createOpfsObjectReader(root);
  return async (bytes) => {
    if (bytes.byteLength < 1 || bytes.byteLength > MAX_OBJECT_BYTES)
      throw new ObjectWriteError("invalid-request");
    const id = contentId(bytes);
    if (!ID.test(id)) throw new ObjectWriteError("invalid-request");
    let handle;
    try {
      const objects = await root.getDirectoryHandle("objects", {
        create: true,
      });
      const prefix = await objects.getDirectoryHandle(id.slice(0, 2), {
        create: true,
      });
      handle = await prefix.getFileHandle(id, { create: true });
      const existing = await handle.getFile();
      if (existing.size > 0) {
        if (existing.size !== bytes.byteLength)
          throw new ObjectWriteError("integrity");
        const prior = new Uint8Array(await existing.arrayBuffer());
        if (!equalBytes(prior, bytes)) throw new ObjectWriteError("integrity");
        return id;
      }
    } catch (error) {
      if (error instanceof ObjectWriteError) throw error;
      throw writeFailure(error);
    }
    try {
      const stream = await handle.createWritable();
      await stream.write(new Uint8Array(bytes));
      await stream.close();
      const verified = await read(id, bytes.byteLength);
      if (!equalBytes(verified, bytes) || contentId(verified) !== id)
        throw new ObjectWriteError("integrity");
      return id;
    } catch (error) {
      if (error instanceof ObjectWriteError) throw error;
      throw writeFailure(error);
    }
  };
}
export async function openOpfsObjectWriter(contentId) {
  if (
    !("storage" in navigator) ||
    typeof navigator.storage.getDirectory !== "function"
  )
    throw new ObjectWriteError("storage-unavailable");
  try {
    return createOpfsObjectWriter(
      await navigator.storage.getDirectory(),
      contentId,
    );
  } catch {
    throw new ObjectWriteError("storage-unavailable");
  }
}
