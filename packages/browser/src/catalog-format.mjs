// Derived from Castalia Web; source license unresolved. See provenance/browser-extraction.json.
const ID = /^[0-9a-f]{64}$/u;
const MAX_REVISIONS = 1024;
export class CatalogError extends Error {
    code;
    constructor(code) {
        super(code);
        this.code = code;
        this.name = "CatalogError";
    }
}
export function parseWorkspaceCatalog(value) {
    if (typeof value !== "object" || value === null || Array.isArray(value))
        throw new CatalogError("unsupported-version");
    const candidate = value;
    const schema = value.schema;
    if (schema !== "castalia.browser-filesystem-catalog.v1")
        throw new CatalogError("unsupported-version");
    if (Object.keys(candidate).sort().join(",") !== "head,revisions,schema" ||
        candidate.schema !== "castalia.browser-filesystem-catalog.v1" ||
        typeof candidate.head !== "string" ||
        !ID.test(candidate.head) ||
        !Array.isArray(candidate.revisions) ||
        candidate.revisions.length < 1 ||
        candidate.revisions.length > MAX_REVISIONS)
        throw new CatalogError("invalid");
    const seen = new Set();
    for (const item of candidate.revisions) {
        const revision = item;
        if (typeof revision !== "object" ||
            revision === null ||
            Object.keys(revision).sort().join(",") !== "committedMs,root" ||
            typeof revision.root !== "string" ||
            !ID.test(revision.root) ||
            typeof revision.committedMs !== "number" ||
            !Number.isSafeInteger(revision.committedMs) ||
            revision.committedMs < 0 ||
            seen.has(revision.root))
            throw new CatalogError("invalid");
        seen.add(revision.root);
    }
    if (candidate.revisions.at(-1)?.root !== candidate.head)
        throw new CatalogError("invalid");
    return structuredClone(candidate);
}
