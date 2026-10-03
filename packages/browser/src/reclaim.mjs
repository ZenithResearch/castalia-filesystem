// Derived from Castalia Web; source license unresolved. See provenance/browser-extraction.json.
import { CatalogError } from "./catalog.mjs";
import { ObjectReadError } from "./opfs-object-reader.mjs";
export class ReclaimError extends Error {
  code;
  constructor(code) {
    super(code);
    this.code = code;
  }
}
export const RECLAIM_LIMITS = {
  objectReads: 250_000,
  bytesRead: 256 * 1024 * 1024,
  retainedIds: 250_000,
  scannedEntries: 250_256,
};
const ID = /^[0-9a-f]{64}$/u;
const PREFIX = /^[0-9a-f]{2}$/u;
/** Budget all reads across all roots, including repeated shared manifests. */
export function budgetReclaimReads(get, limits = RECLAIM_LIMITS) {
  let reads = 0;
  let bytes = 0;
  return async (id, maxBytes) => {
    if (++reads > limits.objectReads || bytes >= limits.bytesRead)
      throw new ReclaimError("reclaim-limit");
    const allowed = Math.min(maxBytes, limits.bytesRead - bytes);
    try {
      const result = await get(id, allowed);
      bytes += result.byteLength;
      if (result.byteLength > allowed || bytes > limits.bytesRead)
        throw new ReclaimError("reclaim-limit");
      return result;
    } catch (error) {
      if (
        allowed < maxBytes &&
        error instanceof ObjectReadError &&
        error.code === "oversized-object"
      )
        throw new ReclaimError("reclaim-limit");
      throw error;
    }
  };
}
export async function reclaimUnusedObjects(
  root,
  loadCatalog,
  reachable,
  limits = RECLAIM_LIMITS,
  loadPinnedRoots = async () => [],
) {
  const catalog = await loadCatalog();
  const pinnedRoots = await loadPinnedRoots();
  if (
    !Array.isArray(pinnedRoots) ||
    pinnedRoots.some((id) => typeof id !== "string" || !ID.test(id))
  )
    throw new ReclaimError("reclaim-unsafe");
  const retained = new Set();
  const roots = new Set([
    ...(catalog?.revisions ?? []).map((revision) => revision.root),
    ...pinnedRoots,
  ]);
  for (const revisionRoot of roots) {
    const ids = JSON.parse(await reachable(revisionRoot));
    if (
      !Array.isArray(ids) ||
      ids.length > limits.retainedIds ||
      ids.some((id) => typeof id !== "string" || !ID.test(id))
    )
      throw new ReclaimError("reclaim-unsafe");
    for (const id of ids) {
      retained.add(id);
      if (retained.size > limits.retainedIds)
        throw new ReclaimError("reclaim-limit");
    }
  }
  let objects;
  try {
    objects = await root.getDirectoryHandle("objects");
  } catch (error) {
    if (error instanceof DOMException && error.name === "NotFoundError")
      return { objects: 0, bytes: 0 };
    throw new ReclaimError("reclaim-unsafe");
  }
  const candidates = [];
  let scanned = 0;
  let totalBytes = 0;
  const count = () => {
    if (++scanned > limits.scannedEntries)
      throw new ReclaimError("reclaim-limit");
  };
  const directories = objects;
  for await (const prefix of directories.values()) {
    count();
    if (prefix.kind !== "directory" || !PREFIX.test(prefix.name))
      throw new ReclaimError("reclaim-unsafe");
    const directory = prefix;
    const entries = directory;
    for await (const entry of entries.values()) {
      count();
      if (
        entry.kind !== "file" ||
        !ID.test(entry.name) ||
        !entry.name.startsWith(prefix.name)
      )
        throw new ReclaimError("reclaim-unsafe");
      if (retained.has(entry.name)) continue;
      const file = await entry.getFile();
      if (!Number.isSafeInteger(file.size) || file.size < 0)
        throw new ReclaimError("reclaim-unsafe");
      totalBytes += file.size;
      if (!Number.isSafeInteger(totalBytes))
        throw new ReclaimError("reclaim-limit");
      candidates.push({ directory, name: entry.name, bytes: file.size });
    }
  }
  if (JSON.stringify(await loadCatalog()) !== JSON.stringify(catalog))
    throw new CatalogError("conflict");
  if (JSON.stringify(await loadPinnedRoots()) !== JSON.stringify(pinnedRoots))
    throw new CatalogError("conflict");
  // No deletion occurs until every root, storage entry and catalog recheck passed.
  let removed = 0;
  let bytes = 0;
  for (const candidate of candidates) {
    await candidate.directory.removeEntry(candidate.name);
    removed += 1;
    bytes += candidate.bytes;
  }
  return { objects: removed, bytes };
}
