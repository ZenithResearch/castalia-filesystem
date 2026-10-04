import { noticeFixture } from "./helpers/notice-fixture.mjs";
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  symlink,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  digest,
  inventory,
  verifyPackage,
  SCHEMA,
  REPOSITORY,
  MANIFEST,
} from "../scripts/lib/package-manifest.mjs";

const revision = "a".repeat(40);
async function fixture(t, patch = {}) {
  const directory = await mkdtemp(join(tmpdir(), "castalia-package-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  for (const folder of ["web", "node"]) {
    await mkdir(join(directory, folder));
    for (const name of [
      "castalia_filesystem_wasm.js",
      "castalia_filesystem_wasm.d.ts",
      "castalia_filesystem_wasm_bg.wasm",
    ]) {
      await writeFile(
        join(directory, folder, name),
        `synthetic fixture ${name}`,
      );
    }
    await writeFile(
      join(directory, folder, "package.json"),
      JSON.stringify({ private: true, castaliaSourceRevision: revision }),
    );
  }
  await writeFile(join(directory, "LICENSE"), "synthetic license");
  await writeFile(join(directory, "SNAPSHOT-V1.md"), "synthetic contract");
  const dependencyLock = "synthetic lock";
  await writeFile(join(directory, "package-lock.json"), dependencyLock);
  await writeFile(
    join(directory, "package.json"),
    JSON.stringify({
      name: "@castalia/filesystem",
      private: true,
      dependencies: { "@zip.js/zip.js": "2.18.2" },
    }),
  );
  for (const path of [
    "packages/browser/src/index.mjs",
    "packages/browser/src/index.d.mts",
    "packages/browser/src/worker.mjs",
    "packages/browser/src/worker.d.mts",
    "packages/browser/src/registration.mjs",
    "docs/BROWSER-ADAPTER.md",
    "licenses/zip-js-BSD-3-Clause.txt",
    "provenance/browser-extraction.json",
    "provenance/browser-supplemental-origins.json",
    "docs/SOURCE-PROVENANCE.md",
    "docs/THIRD-PARTY-NOTICES.md",
    "docs/AGPL-DISTRIBUTION.md",
    "provenance/extraction.json",
    "provenance/local-browser-port.json",
    "provenance/build-tools.json",
    "provenance/wasm-bindgen-cli-0.2.127.Cargo.lock",
  ]) {
    await mkdir(join(directory, path, ".."), { recursive: true });
    await writeFile(join(directory, path), "synthetic browser fixture");
  }
  await noticeFixture(directory,{"castalia-filesystem-wasm/Cargo.lock":"c".repeat(64),"provenance/wasm-bindgen-cli-0.2.127.Cargo.lock":digest("synthetic browser fixture")});
  const manifest = {
    schema: SCHEMA,
    source: {
      repository: REPOSITORY,
      revision,
      dirty: false,
      mode: "candidate",
    },
    tools: {
      rustToolchain: "nightly-2026-06-21",
      rustHost: "aarch64-apple-darwin",
      walrus: "0.26.4",
      rustc: "fixture",
      cargo: "fixture",
      node: "24.18.0",
      wasmPack: "wasm-pack 0.14.0",
      wasmBindgen: "wasm-bindgen 0.2.127",
    },
    locks: {
      "Cargo.lock": "b".repeat(64),
      "castalia-filesystem-wasm/Cargo.lock": "c".repeat(64),
      "package-lock.json": digest(dependencyLock),
      "provenance/wasm-bindgen-cli-0.2.127.Cargo.lock": digest(
        "synthetic browser fixture",
      ),
    },
    normalization: "canonical-build-paths-and-remove-only-wasm-name-section",
    files: await inventory(directory),
    ...patch,
  };
  const bytes = JSON.stringify(manifest);
  await writeFile(join(directory, MANIFEST), bytes);
  return { directory, hash: digest(bytes), manifest };
}

test("complete package verifies against independent source and digest", async (t) => {
  const f = await fixture(t);
  const manifest = await verifyPackage(f.directory, f.hash, revision);
  assert.equal(manifest.files.length, 31);
});

test("changed bytes, missing source pin and wrong digest reject", async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    verifyPackage(f.directory, f.hash, "d".repeat(40)),
    /source or schema/,
  );
  await assert.rejects(
    verifyPackage(f.directory, "e".repeat(64), revision),
    /digest mismatch/,
  );
  await assert.rejects(
    verifyPackage(f.directory, f.hash, undefined),
    /required/,
  );
  await writeFile(
    join(f.directory, "web/castalia_filesystem_wasm_bg.wasm"),
    "changed",
  );
  await assert.rejects(
    verifyPackage(f.directory, f.hash, revision),
    /inventory or bytes/,
  );
});

test("extra files and symlinks cannot escape the reviewed inventory", async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.directory, "unreviewed.js"), "extra");
  await assert.rejects(
    verifyPackage(f.directory, f.hash, revision),
    /inventory or bytes/,
  );
  const g = await fixture(t);
  await symlink(join(g.directory, "LICENSE"), join(g.directory, "link"));
  await assert.rejects(verifyPackage(g.directory, g.hash, revision), /symlink/);
});

test("unknown schemas, tools and fields reject even with matching manifest digest", async (t) => {
  for (const patch of [{ schema: "future" }, { unexpected: true }]) {
    const f = await fixture(t, patch);
    await assert.rejects(verifyPackage(f.directory, f.hash, revision));
  }
  const f = await fixture(t);
  f.manifest.tools.wasmBindgen = "wasm-bindgen future";
  const bytes = JSON.stringify(f.manifest);
  await writeFile(join(f.directory, MANIFEST), bytes);
  await assert.rejects(
    verifyPackage(f.directory, digest(bytes), revision),
    /tools/,
  );
});

test("dirty and development builds require an explicit diagnostic exception", async (t) => {
  const f = await fixture(t, {
    source: {
      repository: REPOSITORY,
      revision,
      dirty: true,
      mode: "development",
    },
  });
  await assert.rejects(
    verifyPackage(f.directory, f.hash, revision),
    /development packages/,
  );
  await verifyPackage(f.directory, f.hash, revision, { development: true });
});

test("publishable or source-unbound metadata fails after inventory verification", async (t) => {
  const f = await fixture(t);
  const path = join(f.directory, "web/package.json");
  const metadata = JSON.parse(await readFile(path, "utf8"));
  metadata.private = false;
  await writeFile(path, JSON.stringify(metadata));
  f.manifest.files = await inventory(f.directory);
  const bytes = JSON.stringify(f.manifest);
  await writeFile(join(f.directory, MANIFEST), bytes);
  await assert.rejects(
    verifyPackage(f.directory, digest(bytes), revision),
    /publishable/,
  );
});

// Rehashing the outer inventory cannot make missing source notices a complete package.
test("required notice payloads cannot be omitted even with a freshly calculated manifest",async t=>{const f=await fixture(t);await rm(join(f.directory,"licenses/cargo-runtime-notices.txt"));f.manifest.files=await inventory(f.directory);const bytes=JSON.stringify(f.manifest);await writeFile(join(f.directory,MANIFEST),bytes);await assert.rejects(verifyPackage(f.directory,digest(bytes),revision),/missing package file/);});
