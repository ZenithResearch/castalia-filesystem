// Derived from Castalia Web; source license unresolved. See provenance/browser-extraction.json.
import { ZipImportError } from "./import-zip.mjs";
/** Keeps the Blob-based download path bounded and never exposes partial ZIPs. */
export function createBoundedZipOutput(maxBytes) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1)
    throw new ZipImportError("archive-limit");
  const chunks = [];
  let written = 0;
  let closed = false;
  const stream = new WritableStream({
    write(bytes) {
      written += bytes.byteLength;
      if (written > maxBytes) throw new ZipImportError("archive-limit");
      chunks.push(new Uint8Array(bytes));
    },
    close() {
      closed = true;
    },
  });
  return {
    stream,
    blob() {
      if (!closed) throw new ZipImportError("invalid-archive");
      return new Blob(chunks, { type: "application/zip" });
    },
  };
}
