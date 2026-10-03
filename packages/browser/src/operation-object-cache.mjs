// Derived from Castalia Web; source license unresolved. See provenance/browser-extraction.json.
import { ObjectReadError } from "./opfs-object-reader.mjs";
/** A bounded, operation-scoped cache for immutable content-addressed reads. */
export function createOperationObjectCache(get, budgetBytes) {
  if (!Number.isSafeInteger(budgetBytes) || budgetBytes < 0)
    throw new ObjectReadError("invalid-request");
  const entries = new Map();
  let used = 0;
  return async (id, maxBytes) => {
    const cached = entries.get(id);
    if (cached) {
      if (cached.byteLength > maxBytes)
        throw new ObjectReadError("oversized-object");
      entries.delete(id);
      entries.set(id, cached);
      return cached;
    }
    const bytes = await get(id, maxBytes);
    if (bytes.byteLength > maxBytes)
      throw new ObjectReadError("oversized-object");
    if (bytes.byteLength <= budgetBytes) {
      while (used + bytes.byteLength > budgetBytes) {
        const oldest = entries.keys().next().value;
        if (oldest === undefined) break;
        used -= entries.get(oldest)?.byteLength ?? 0;
        entries.delete(oldest);
      }
      entries.set(id, bytes);
      used += bytes.byteLength;
    }
    return bytes;
  };
}
