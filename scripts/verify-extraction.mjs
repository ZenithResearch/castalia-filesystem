import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { digest } from "./lib/package-manifest.mjs";

const root = new URL("../", import.meta.url);
const provenance = JSON.parse(await readFile(new URL("provenance/extraction.json", root), "utf8"));
const browserPort = JSON.parse(await readFile(new URL("provenance/local-browser-port.json", root), "utf8"));
assert.equal(provenance.schema, "castalia.filesystem.extraction.v1");
assert.equal(provenance.sourceRevision, "c5c0374d8ee00170bfd86c636a708f5c6284bb19");
assert.equal(provenance.files.length, 21);
assert.equal(browserPort.schema, "castalia.filesystem.local-browser-port.v1");
assert.equal(browserPort.sourceRepository, "https://github.com/bananawalnut/castalia");
assert.equal(browserPort.sourceRevision, "95e6208a4b5834887bb7521aa5a90db12e6cbb5b");
assert.equal(browserPort.files.length, 6);
const ported = new Map(browserPort.files.map((entry) => [entry.path, entry]));
assert.equal(ported.size, browserPort.files.length);
for (const entry of provenance.files) {
  assert.match(entry.path, /^castalia-filesystem-(?:core|wasm)\//u);
  assert.ok(!entry.path.split("/").includes(".."));
  const current = digest(await readFile(new URL(entry.path, root)));
  const port = ported.get(entry.path);
  if (port) {
    assert.equal(port.beforeSha256, entry.extractedSha256, entry.path);
    assert.equal(current, port.sourceSha256, entry.path);
    ported.delete(entry.path);
  } else {
    assert.equal(current, entry.extractedSha256, entry.path);
  }
  if (!entry.change) assert.equal(entry.extractedSha256, entry.originalSha256, entry.path);
}
assert.equal(ported.size, 0, "all local browser port paths must be in the extraction inventory");
assert.equal(digest(await readFile(new URL("Cargo.lock", root))), provenance.nativeLock.sha256);
assert.equal(await readFile(new URL("LICENSE", root), "utf8"),
  await readFile(new URL("castalia-filesystem-wasm/LICENSE", root), "utf8"));
console.log(`Verified ${provenance.files.length} extracted/ported files and reviewed native lock in ${fileURLToPath(root)}`);
