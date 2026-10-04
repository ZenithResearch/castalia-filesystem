import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { digest } from "./lib/package-manifest.mjs";

const root = new URL("../", import.meta.url);
const provenance = JSON.parse(await readFile(new URL("provenance/extraction.json", root), "utf8"));
assert.equal(provenance.schema, "castalia.filesystem.extraction.v1");
assert.equal(provenance.sourceRevision, "c5c0374d8ee00170bfd86c636a708f5c6284bb19");
assert.equal(provenance.files.length, 21);
for (const entry of provenance.files) {
  assert.match(entry.path, /^castalia-filesystem-(?:core|wasm)\//u);
  assert.ok(!entry.path.split("/").includes(".."));
  assert.equal(digest(await readFile(new URL(entry.path, root))), entry.extractedSha256, entry.path);
  if (!entry.change) assert.equal(entry.extractedSha256, entry.originalSha256, entry.path);
}
assert.equal(digest(await readFile(new URL("Cargo.lock", root))), provenance.nativeLock.sha256);
assert.equal(await readFile(new URL("LICENSE", root), "utf8"),
  await readFile(new URL("castalia-filesystem-wasm/LICENSE", root), "utf8"));
console.log(`Verified ${provenance.files.length} extracted files and reviewed native lock in ${fileURLToPath(root)}`);
