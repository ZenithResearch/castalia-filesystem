// Derived from Castalia Web; source license unresolved. See provenance/browser-extraction.json.
import { BlobReader, ZipReader } from "@zip.js/zip.js/lib/zip-core-native.js";
const MIB = 1024 * 1024;
export const ZIP_LIMITS = {
  compressed: 50 * MIB,
  expanded: 100 * MIB,
  file: 32 * MIB,
  entries: 1000,
  chunk: MIB,
};
export class ZipImportError extends Error {
  code;
  constructor(code) {
    super(code);
    this.code = code;
    this.name = "ZipImportError";
  }
}
export function validateZipPath(raw, directory) {
  const name = directory && raw.endsWith("/") ? raw.slice(0, -1) : raw;
  if (
    !name ||
    name.startsWith("/") ||
    name.includes("\\") ||
    name.includes("\0") ||
    (!directory && name.endsWith("/"))
  )
    throw new ZipImportError("unsafe-path");
  const parts = name.split("/");
  if (
    parts.length > 64 ||
    parts.some(
      (part) =>
        !part ||
        part === "." ||
        part === ".." ||
        new TextEncoder().encode(part).byteLength > 255 ||
        /[\p{Cc}\p{Cf}]/u.test(part),
    ) ||
    new TextEncoder().encode(`/${name}`).byteLength > 4096
  )
    throw new ZipImportError("unsafe-path");
  return `/${name}`;
}
function timestamp(entry) {
  const value = entry.lastModDate.getTime();
  if (!Number.isSafeInteger(value) || value < 0)
    throw new ZipImportError("invalid-archive");
  return value;
}
function validateEntry(entry) {
  if (entry.encrypted || entry.symlink)
    throw new ZipImportError("unsupported-entry");
  const mode = entry.unixMode;
  if (mode !== undefined) {
    const fileType = mode & 0o170000;
    if (
      (fileType !== 0 &&
        fileType !== (entry.directory ? 0o040000 : 0o100000)) ||
      (mode & 0o7000) !== 0
    )
      throw new ZipImportError("unsupported-entry");
  }
  for (const size of [entry.compressedSize, entry.uncompressedSize]) {
    if (!Number.isSafeInteger(size) || size < 0)
      throw new ZipImportError("invalid-archive");
  }
  if (!entry.directory && entry.uncompressedSize > ZIP_LIMITS.file)
    throw new ZipImportError("archive-limit");
  if (entry.directory && entry.uncompressedSize !== 0)
    throw new ZipImportError("invalid-archive");
  timestamp(entry);
}
function assertActive(signal) {
  if (signal?.aborted) throw new ZipImportError("cancelled");
}
/**
 * Validate the entire central directory before calling the sink. Actual
 * decompressed bytes are counted again while streaming; advertised sizes are
 * never trusted as a decompression-bomb guard.
 */
export async function importZip(file, sink, signal, onProgress) {
  assertActive(signal);
  if (file.size > ZIP_LIMITS.compressed)
    throw new ZipImportError("archive-limit");
  const reader = new ZipReader(new BlobReader(file), {
    strictness: "strict",
    checkCrc32: true,
    useWebWorkers: false,
  });
  try {
    const entries = [];
    try {
      for await (const entry of reader.getEntriesGenerator()) {
        entries.push(entry);
        if (entries.length > ZIP_LIMITS.entries)
          throw new ZipImportError("archive-limit");
      }
    } catch (error) {
      if (error instanceof ZipImportError) throw error;
      assertActive(signal);
      throw new ZipImportError("invalid-archive");
    }
    const seen = new Set();
    const canonicalParts = new Map();
    const filePaths = new Set();
    const parentPaths = new Set();
    const paths = entries.map((entry) => {
      assertActive(signal);
      validateEntry(entry);
      const path = validateZipPath(entry.filename, entry.directory);
      const folded = path.toLowerCase();
      if (seen.has(folded)) throw new ZipImportError("unsafe-path");
      seen.add(folded);
      const components = path.slice(1).split("/");
      for (let depth = 1; depth <= components.length; depth += 1) {
        const prefix = components.slice(0, depth).join("/");
        const foldedPrefix = prefix.toLowerCase();
        const earlier = canonicalParts.get(foldedPrefix);
        if (earlier !== undefined && earlier !== prefix)
          throw new ZipImportError("unsafe-path");
        canonicalParts.set(foldedPrefix, prefix);
        if (depth < components.length) {
          if (filePaths.has(foldedPrefix))
            throw new ZipImportError("unsafe-path");
          parentPaths.add(foldedPrefix);
        }
      }
      if (!entry.directory) {
        if (parentPaths.has(folded)) throw new ZipImportError("unsafe-path");
        filePaths.add(folded);
      }
      return { entry, path };
    });
    for (const { entry, path } of paths) {
      if (entry.directory && filePaths.has(path.toLowerCase()))
        throw new ZipImportError("unsafe-path");
    }
    let advertised = 0;
    for (const { entry } of paths) {
      advertised += entry.uncompressedSize;
      if (advertised > ZIP_LIMITS.expanded)
        throw new ZipImportError("archive-limit");
    }
    paths.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    let expanded = 0;
    let completed = 0;
    let reportedBytes = 0;
    const progress = () => {
      onProgress?.({ completed, total: paths.length, expandedBytes: expanded });
    };
    progress();
    for (const { entry, path } of paths) {
      assertActive(signal);
      if (entry.directory) {
        await sink.addDirectory(path, timestamp(entry));
        completed += 1;
        progress();
        continue;
      }
      await sink.beginFile(path, timestamp(entry), false);
      let fileBytes = 0;
      let sinkFailure;
      try {
        await entry.getData(
          new WritableStream({
            async write(bytes) {
              try {
                assertActive(signal);
                fileBytes += bytes.byteLength;
                expanded += bytes.byteLength;
                if (
                  fileBytes > ZIP_LIMITS.file ||
                  expanded > ZIP_LIMITS.expanded
                )
                  throw new ZipImportError("archive-limit");
                for (
                  let offset = 0;
                  offset < bytes.byteLength;
                  offset += ZIP_LIMITS.chunk
                )
                  await sink.appendChunk(
                    bytes.slice(offset, offset + ZIP_LIMITS.chunk),
                  );
                if (expanded - reportedBytes >= ZIP_LIMITS.chunk) {
                  reportedBytes = expanded;
                  progress();
                }
              } catch (error) {
                sinkFailure = error;
                throw error;
              }
            },
          }),
          {
            ...(signal ? { signal } : {}),
            strictness: "strict",
            checkCrc32: true,
          },
        );
      } catch {
        if (sinkFailure !== undefined)
          throw sinkFailure instanceof Error
            ? sinkFailure
            : new Error(
                typeof sinkFailure === "string"
                  ? sinkFailure
                  : "filesystem storage callback failed",
              );
        assertActive(signal);
        throw new ZipImportError("invalid-archive");
      }
      if (fileBytes !== entry.uncompressedSize)
        throw new ZipImportError("invalid-archive");
      assertActive(signal);
      await sink.finishFile();
      completed += 1;
      progress();
    }
  } finally {
    await reader.close();
  }
}
