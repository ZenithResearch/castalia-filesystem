import { verifyNotices } from "./notices.mjs";
import { createHash } from "node:crypto";
import { lstat, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

export const MANIFEST = "filesystem-package-manifest.json";
export const SCHEMA = "castalia.filesystem.package.v1";
export const REPOSITORY = "https://github.com/ZenithResearch/castalia-filesystem";
export const SHA256 = /^[0-9a-f]{64}$/u;
const REVISION = /^[0-9a-f]{40}$/u;
const MAX_FILES = 256;
const MAX_BYTES = 64 * 1024 * 1024;
export const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");

function keys(value, names) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).sort().join(",") !== [...names].sort().join(",")) {
    throw new Error("invalid manifest fields");
  }
}

export async function inventory(directory) {
  const entries = [];
  let total = 0;
  async function walk(relative) {
    for (const name of (await readdir(join(directory, relative))).sort()) {
      const path = relative ? `${relative}/${name}` : name;
      if (path === MANIFEST) continue;
      if (!/^[A-Za-z0-9_.\/-]+$/u.test(path) ||
          path.split("/").some((part) => !part || part === "." || part === "..")) {
        throw new Error("unsafe package path");
      }
      const stat = await lstat(join(directory, path));
      if (stat.isSymbolicLink()) throw new Error("package symlink rejected");
      if (stat.isDirectory()) { await walk(path); continue; }
      if (!stat.isFile()) throw new Error("nonregular package entry");
      if (!Number.isSafeInteger(stat.size) || stat.size < 0 ||
          (total += stat.size) > MAX_BYTES || entries.length >= MAX_FILES) {
        throw new Error("package size limit");
      }
      const bytes = await readFile(join(directory, path));
      if (bytes.byteLength !== stat.size) throw new Error("package changed during read");
      entries.push({ path, size: bytes.byteLength, sha256: digest(bytes) });
    }
  }
  await walk("");
  return entries.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
}

export async function verifyPackage(directory, expectedDigest, expectedRevision, { development = false } = {}) {
  if (!SHA256.test(expectedDigest) || !REVISION.test(expectedRevision)) {
    throw new Error("independent manifest SHA-256 and source commit are required");
  }
  const manifestPath = join(directory, MANIFEST);
  const stat = await lstat(manifestPath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024) {
    throw new Error("invalid package manifest file");
  }
  const bytes = await readFile(manifestPath);
  if (digest(bytes) !== expectedDigest) throw new Error("package manifest digest mismatch");
  const manifest = JSON.parse(bytes);
  keys(manifest, ["schema", "source", "tools", "locks", "normalization", "files"]);
  keys(manifest.source, ["repository", "revision", "dirty", "mode"]);
  if (manifest.schema !== SCHEMA || manifest.source.repository !== REPOSITORY ||
      manifest.source.revision !== expectedRevision || typeof manifest.source.dirty !== "boolean" ||
      !["candidate", "development"].includes(manifest.source.mode)) {
    throw new Error("unsupported package source or schema");
  }
  if (!development && (manifest.source.dirty || manifest.source.mode !== "candidate")) {
    throw new Error("development packages are not review candidates");
  }
  keys(manifest.tools, ["rustToolchain", "rustHost", "walrus", "rustc", "cargo", "node", "wasmPack", "wasmBindgen"]);
  if (manifest.tools.rustHost !== "aarch64-apple-darwin" || manifest.tools.walrus !== "0.26.4" || manifest.tools.rustToolchain !== "nightly-2026-06-21" ||
      manifest.tools.node !== "24.18.0" || manifest.tools.wasmPack !== "wasm-pack 0.14.0" ||
      manifest.tools.wasmBindgen !== "wasm-bindgen 0.2.127" ||
      typeof manifest.tools.rustc !== "string" || typeof manifest.tools.cargo !== "string") {
    throw new Error("unsupported package tools");
  }
  keys(manifest.locks, ["Cargo.lock", "castalia-filesystem-wasm/Cargo.lock", "provenance/wasm-bindgen-cli-0.2.127.Cargo.lock"]);
  if (!Object.values(manifest.locks).every((value) => SHA256.test(value)) ||
      manifest.normalization !== "canonical-build-paths-and-remove-only-wasm-name-section") {
    throw new Error("invalid package provenance");
  }
  if (!Array.isArray(manifest.files) || manifest.files.length === 0 || manifest.files.length > MAX_FILES) {
    throw new Error("invalid package file inventory");
  }
  const actual = await inventory(directory);
  if (JSON.stringify(actual) !== JSON.stringify(manifest.files)) {
    throw new Error("package inventory or bytes differ");
  }
  for (const path of ["docs/SOURCE-PROVENANCE.md","docs/THIRD-PARTY-NOTICES.md","docs/AGPL-DISTRIBUTION.md","provenance/notices.json","provenance/extraction.json","licenses/cargo-runtime-notices.txt","licenses/rust-standard-library.html","LICENSE", "SNAPSHOT-V1.md", "provenance/build-tools.json", "provenance/wasm-bindgen-cli-0.2.127.Cargo.lock",
    "web/castalia_filesystem_wasm.js", "web/castalia_filesystem_wasm.d.ts",
    "web/castalia_filesystem_wasm_bg.wasm", "web/package.json",
    "node/castalia_filesystem_wasm.js", "node/castalia_filesystem_wasm.d.ts",
    "node/castalia_filesystem_wasm_bg.wasm", "node/package.json"]) {
    if (!actual.some((entry) => entry.path === path)) throw new Error(`missing package file: ${path}`);
  }
  if(digest(await readFile(join(directory,"provenance/wasm-bindgen-cli-0.2.127.Cargo.lock")))!==manifest.locks["provenance/wasm-bindgen-cli-0.2.127.Cargo.lock"])throw new Error("binding tool lock digest mismatch");
  for (const target of ["web", "node"]) {
    const metadata = JSON.parse(await readFile(join(directory, target, "package.json"), "utf8"));
    if (metadata.private !== true || metadata.castaliaSourceRevision !== expectedRevision) {
      throw new Error("unbound or publishable generated package");
    }
  }
  await verifyNotices(directory, manifest.locks);
  return manifest;
}
