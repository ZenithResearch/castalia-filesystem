import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, writeFile, mkdir, readFile, access, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lockedMetadata } from "../scripts/lib/process.mjs";
import { stripWasmNameSection } from "../scripts/lib/strip-wasm-name.mjs";

async function crate(t, { version = "0.1.0", lock = true } = {}) {
  const path = await mkdtemp(join(tmpdir(), "castalia-locked-build-test-"));
  t.after(() => rm(path, { recursive: true, force: true }));
  await mkdir(join(path, "src"));
  await writeFile(join(path, "src/lib.rs"), "pub fn fixture() {}\n");
  await writeFile(join(path, "Cargo.toml"), `[package]\nname = "locked-build-fixture"\nversion = "${version}"\nedition = "2024"\n[workspace]\n`);
  if (lock) await writeFile(join(path, "Cargo.lock"), 'version = 4\n\n[[package]]\nname = "locked-build-fixture"\nversion = "0.1.0"\n');
  return path;
}

test("real Cargo locked metadata accepts a reviewed lock unchanged", async (t) => {
  const path = await crate(t);
  const before = await readFile(join(path, "Cargo.lock"));
  const metadata = lockedMetadata(join(path, "Cargo.toml"));
  assert.equal(metadata.packages[0].name, "locked-build-fixture");
  assert.deepEqual(await readFile(join(path, "Cargo.lock")), before);
});

test("real Cargo rejects a missing lock without creating one", async (t) => {
  const path = await crate(t, { lock: false });
  assert.throws(() => lockedMetadata(join(path, "Cargo.toml")));
  await assert.rejects(access(join(path, "Cargo.lock")));
});

test("real Cargo rejects a stale lock without repairing it", async (t) => {
  const path = await crate(t, { version: "0.2.0" });
  const before = await readFile(join(path, "Cargo.lock"));
  assert.throws(() => lockedMetadata(join(path, "Cargo.toml")));
  assert.deepEqual(await readFile(join(path, "Cargo.lock")), before);
});

test("normalization removes only the optional name custom section", () => {
  const header = Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]);
  const name = Buffer.from([0, 5, 4, 110, 97, 109, 101]);
  const other = Buffer.from([0, 5, 3, 102, 111, 111, 9]);
  const input = Buffer.concat([header, name, other]);
  assert.deepEqual(stripWasmNameSection(input), Buffer.concat([header, other]));
  assert.throws(() => stripWasmNameSection(Buffer.concat([header, other])), /exactly one/);
  assert.throws(() => stripWasmNameSection(input.subarray(0, input.length - 1)), /truncated/);
});
