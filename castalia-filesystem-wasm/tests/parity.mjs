import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const packagePath = process.argv[2];
if (!packagePath) throw new Error("pass the wasm-pack nodejs package path");
const require = createRequire(import.meta.url);
const wasm = require(resolve(packagePath, "castalia_filesystem_wasm.js"));
const bytes = (value) => new TextEncoder().encode(value);
const fixture = readFileSync(
  new URL("../../castalia-filesystem-core/fixtures/empty-directory-v1.json", import.meta.url),
);
const canonical = fixture.subarray(0, fixture.length - 1);
assert.deepEqual(wasm.canonical_manifest(canonical), new Uint8Array(canonical));
assert.equal(
  wasm.canonical_manifest_id(canonical),
  "f1be639a408254dbc5b180987530d04647112010e221fc3ee04aa440b1af580f",
);
assert.throws(() => wasm.canonical_manifest(fixture));
assert.throws(() => wasm.canonical_manifest(bytes(` ${new TextDecoder().decode(canonical)}`)));

const objects = new Map();
function putChunk(value) {
  const id = wasm.content_id(value);
  objects.set(id, value);
  return id;
}
function putManifest(node) {
  const value = bytes(JSON.stringify({ schema_version: 1, node }));
  const id = wasm.canonical_manifest_id(value);
  objects.set(id, value);
  return id;
}
const namespace = wasm.content_id(bytes("browser bridge fixture"));
const chunk = bytes("hello, snapshot\n");
const chunkId = putChunk(chunk);
const fileId = putManifest({
  kind: "file",
  body: {
    inode: 2,
    modified_ms: 0,
    executable: false,
    size: chunk.length,
    chunks: [{ content: chunkId, size: chunk.length }],
  },
});
const directoryId = putManifest({
  kind: "directory",
  body: {
    inode: 1,
    modified_ms: 0,
    entries: [{ name: "hello.txt", node: { inode: 2, kind: "file", manifest: fileId } }],
  },
});
const snapshotId = putManifest({
  kind: "snapshot",
  body: {
    namespace,
    generation: 0,
    previous: null,
    root: { inode: 1, kind: "directory", manifest: directoryId },
  },
});
const producer = new wasm.BrowserSnapshotBuilder(namespace, 0n, async (value) => {
  const stored = new Uint8Array(value);
  const id = wasm.content_id(stored);
  objects.set(id, stored);
  return id;
});
assert.throws(() => producer.begin_file("/../escape", 0n, false));
producer.begin_file("/hello.txt", 0n, false);
await producer.append_chunk(chunk);
producer.finish_file();
assert.equal(await producer.finish(), snapshotId);
let requestedCap = 0;
const getObject = async (id, maxBytes) => {
  requestedCap = maxBytes;
  const value = objects.get(id);
  if (!value) throw new Error("object unavailable");
  if (value.length > maxBytes) throw new Error("oversize before copy");
  return value;
};
const putObject = async (value) => {
  const stored = new Uint8Array(value);
  const id = wasm.content_id(stored);
  objects.set(id, stored);
  return id;
};
const reader = new wasm.PinnedSnapshotReader(getObject);
assert.equal(await reader.validate_tree(snapshotId), 2);
assert.equal(await reader.validate_tree_bounded(snapshotId, BigInt(chunk.length)), 2);
await assert.rejects(reader.validate_tree_bounded(snapshotId, BigInt(chunk.length - 1)), /Limit/);
assert.deepEqual(
  JSON.parse(await reader.reachable_ids_bounded(snapshotId, 16, 1024n * 1024n)),
  [chunkId, fileId, directoryId, snapshotId].sort(),
);
await assert.rejects(reader.reachable_ids_bounded(snapshotId, 1, 1024n * 1024n), /Limit/);
assert.equal(JSON.parse(await reader.list(snapshotId, "/"))[0].name, "hello.txt");
assert.equal(JSON.parse(await reader.stat(snapshotId, "/hello.txt")).body.size, chunk.length);
assert.deepEqual(await reader.read_range(snapshotId, "/hello.txt", 7n, 8), chunk.subarray(7, 15));
assert.equal(requestedCap, chunk.length);
const replacement = bytes("revised content\n");
const revision = new wasm.BrowserFileRevision(snapshotId, "/hello.txt", 1n, false, getObject, putObject);
await revision.append_chunk(replacement);
const revisionId = await revision.finish();
assert.deepEqual(await reader.read_range(snapshotId, "/hello.txt", 0n, chunk.length), chunk);
assert.deepEqual(await reader.read_range(revisionId, "/hello.txt", 0n, replacement.length), replacement);
const revisedManifest = JSON.parse(new TextDecoder().decode(objects.get(revisionId)));
assert.equal(revisedManifest.node.body.previous, snapshotId);
assert.equal(revisedManifest.node.body.generation, 1);
assert.equal(JSON.parse(await reader.stat(revisionId, "/hello.txt")).body.inode, 2);
const directoryRevision = new wasm.BrowserDirectoryRevision(revisionId, "/drafts", 2n, getObject, putObject);
const createdDirectoryId = await directoryRevision.finish();
assert.deepEqual(JSON.parse(await reader.list(createdDirectoryId, "/drafts")), []);
assert.equal(JSON.parse(await reader.stat(createdDirectoryId, "/drafts")).body.modified_ms, 2);
assert.equal(JSON.parse(await reader.list(revisionId, "/")).length, 1);
const newFile = new wasm.BrowserFileRevision(createdDirectoryId, "/drafts/new.md", 3n, false, getObject, putObject);
await newFile.append_chunk(bytes("written in browser\n"));
const createdId = await newFile.finish_new();
assert.deepEqual(
  await reader.read_range(createdId, "/drafts/new.md", 0n, 64),
  bytes("written in browser\n"),
);
const collision = new wasm.BrowserFileRevision(createdId, "/drafts/new.md", 4n, false, getObject, putObject);
await assert.rejects(collision.finish_new(), /entry exists/);
const duplicateFolder = new wasm.BrowserDirectoryRevision(createdId, "/drafts", 4n, getObject, putObject);
await assert.rejects(duplicateFolder.finish(), /entry exists/);
const missingReader = new wasm.PinnedSnapshotReader(async () => {
  throw Object.assign(new Error("missing"), { code: "missing-object" });
});
await assert.rejects(missingReader.validate_tree(snapshotId), /NotFound/);
const quotaBuilder = new wasm.BrowserSnapshotBuilder(namespace, 0n, async () => {
  throw Object.assign(new Error("full"), { code: "quota" });
});
quotaBuilder.begin_file("/blocked.txt", 0n, false);
await assert.rejects(quotaBuilder.append_chunk(bytes("blocked")), /quota/);
objects.set(chunkId, bytes("tampered content\n"));
await assert.rejects(reader.read_range(snapshotId, "/hello.txt", 0n, chunk.length));
await assert.rejects(reader.reachable_ids_bounded(snapshotId, 16, 1024n * 1024n));
console.log("filesystem WASM parity: canonical manifest, pinned reads, file/folder revisions, bounds, tamper rejection passed");
