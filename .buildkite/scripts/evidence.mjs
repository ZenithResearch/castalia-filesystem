import assert from "node:assert/strict";
import { readFile, writeFile, readdir, lstat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const native = ["cargo-fetch", "extraction", "source-tests", "native-tests", "clippy", "rust-format", "wasm-format", "wasm-check"];
const candidate = ["wasm-pack-install", "wasm-bindgen-install", "cargo-fetch", "wasm-fetch", "npm-lock", "extraction", "immutable-package", "actual-wasm"];
export const CHECKS = Object.freeze({
  linux: ["npm-lock", "ci-contract", "browser-tests", "retained-tests", "browser-types", ...native, "services-lock", "services-tests", "operator-package-one", "operator-package-two", "operator-equality", "packaged-services-tests"],
  "mac-native": native,
  "candidate-one": candidate,
  "candidate-two": candidate,
  compare: ["producer-evidence", "extracted-bindings", "operator-inventory", "package-equality"],
});
const locks = ["Cargo.lock", "castalia-filesystem-wasm/Cargo.lock", "package-lock.json", "services/package-lock.json", "provenance/wasm-bindgen-cli-0.2.127.Cargo.lock"];
const sha = bytes => createHash("sha256").update(bytes).digest("hex");
const run = (program, args) => execFileSync(program, args, { encoding: "utf8" }).trim();
const git = (...args) => run("git", args);
export async function lockHashes(root = ".") {
  return Object.fromEntries(await Promise.all(locks.map(async path => [path, sha(await readFile(join(root, path)))])));
}
export function validateEvidence(record, job, context) {
  assert.ok(CHECKS[job], "unknown evidence job");
  assert.equal(record.schema, "castalia.filesystem.buildkite-job.v1");
  assert.equal(record.job, job);
  assert.equal(record.status, "passed");
  assert.match(record.commit, /^[0-9a-f]{40}$/);
  assert.equal(record.commit, context.commit, "different source commit");
  assert.equal(record.tree, context.tree, "different source tree");
  assert.equal(record.buildId, context.buildId, "different Buildkite build");
  assert.ok(typeof record.jobId === "string" && record.jobId.length > 0, "missing job identity");
  assert.deepEqual(record.checks, CHECKS[job], "missing, reordered or unexpected checks");
  assert.deepEqual(record.locks, context.locks, "changed lockfile");
  assert.equal(record.tools.node, "v24.18.0");
  assert.equal(record.tools.platform, job === "linux" || job === "compare" ? "linux" : "darwin");
  assert.equal(record.tools.arch, job === "linux" || job === "compare" ? "x64" : "arm64");
  if (job !== "compare") {
    assert.equal(record.tools.rustToolchain, "nightly-2026-06-21");
    assert.ok(record.tools.rustc && record.tools.cargo, "missing compiler identity");
  }
  if (job.startsWith("candidate-")) {
    assert.equal(record.tools.wasmPack, "wasm-pack 0.14.0");
    assert.equal(record.tools.wasmBindgen, "wasm-bindgen 0.2.127");
  }
  if (job === "linux" || job.startsWith("candidate-")) {
    assert.match(record.package.manifestSha256, /^[0-9a-f]{64}$/);
    assert.match(record.package.archiveSha256, /^[0-9a-f]{64}$/);
    assert.ok(Number.isSafeInteger(record.package.files) && record.package.files > 0);
  }
}
async function context() {
  const commit = git("rev-parse", "HEAD");
  assert.equal(commit, process.env.BUILDKITE_COMMIT, "checkout changed");
  assert.equal(git("status", "--porcelain", "--untracked-files=all"), "", "source became dirty");
  assert.ok(process.env.BUILDKITE_BUILD_ID, "missing Buildkite build identity");
  return { commit, tree: git("rev-parse", "HEAD^{tree}"), buildId: process.env.BUILDKITE_BUILD_ID, locks: await lockHashes() };
}
async function record(job, directory, packageDirectory) {
  const ctx = await context();
  const tools = { node: process.version, platform: process.platform, arch: process.arch };
  if (job !== "compare") Object.assign(tools, {
    rustToolchain: "nightly-2026-06-21",
    rustc: run("rustc", ["+nightly-2026-06-21", "-vV"]),
    cargo: run("cargo", ["+nightly-2026-06-21", "--version"]),
  });
  if (job.startsWith("candidate-")) Object.assign(tools, { wasmPack: run("wasm-pack", ["--version"]), wasmBindgen: run("wasm-bindgen", ["--version"]) });
  const result = { schema: "castalia.filesystem.buildkite-job.v1", job, status: "passed", ...ctx, jobId: process.env.BUILDKITE_JOB_ID, tools, checks: (await readFile(join(directory, "checks.txt"), "utf8")).trim().split("\n") };
  if (packageDirectory) {
    const name = job === "linux" ? "manifest.json" : "filesystem-package-manifest.json";
    const bytes = await readFile(join(packageDirectory, name));
    const manifest = JSON.parse(bytes);
    assert.equal(job === "linux" ? manifest.sourceRevision : manifest.source.revision, ctx.commit);
    assert.equal(job === "linux" ? manifest.sourceDirty : manifest.source.dirty, false);
    result.package = { manifestSha256: sha(bytes), archiveSha256: sha(await readFile(join(directory, "package.tar.gz"))), files: manifest.files.length };
  }
  validateEvidence(result, job, ctx);
  await writeFile(join(directory, "job.json"), JSON.stringify(result, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  console.log(`Verified ${job} at ${ctx.commit}`);
}
export async function verifyProducerEvidence(directory, ctx) {
  const jobIds = new Set();
  for (const job of ["linux", "mac-native", "candidate-one", "candidate-two"]) {
    const result = JSON.parse(await readFile(join(directory, job, "job.json"), "utf8"));
    validateEvidence(result, job, ctx);
    assert.ok(!jobIds.has(result.jobId), "producers must be independent jobs");
    jobIds.add(result.jobId);
    if (result.package) assert.equal(sha(await readFile(join(directory, job, "package.tar.gz"))), result.package.archiveSha256, "archive bytes changed");
  }
}
export async function verifyOperatorPackage(directory, expectedCommit) {
  const manifest = JSON.parse(await readFile(join(directory, "manifest.json"), "utf8"));
  assert.equal(manifest.schema, "castalia.files-services-package.v1");
  assert.equal(manifest.sourceRevision, expectedCommit);
  assert.equal(manifest.sourceDirty, false);
  assert.equal(manifest.node, "24.18.0");
  assert.equal(manifest.s3dRevision, "e468d007cfc9eefa083d09b5a858ba294f64f6cf");
  const files = [];
  async function walk(path = "") {
    for (const name of await readdir(join(directory, path))) {
      const relative = path ? `${path}/${name}` : name;
      if (relative === "manifest.json") continue;
      const stat = await lstat(join(directory, relative));
      assert.ok(!stat.isSymbolicLink(), "package symlink");
      if (stat.isDirectory()) await walk(relative);
      else {
        assert.ok(stat.isFile(), "nonregular package entry");
        const bytes = await readFile(join(directory, relative));
        files.push({ path: relative, bytes: bytes.length, sha256: sha(bytes) });
      }
    }
  }
  await walk();
  files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  assert.deepEqual(files, manifest.files, "operator inventory mismatch");
}
async function verifyUnpacked(records, directory) {
  for (const [job, path, manifestName] of [
    ["linux", "operator", "manifest.json"],
    ["candidate-one", "replicas/candidate-one", "filesystem-package-manifest.json"],
    ["candidate-two", "replicas/candidate-two", "filesystem-package-manifest.json"],
  ]) {
    const record = JSON.parse(await readFile(join(records, job, "job.json"), "utf8"));
    const bytes = await readFile(join(directory, path, manifestName));
    assert.equal(sha(bytes), record.package.manifestSha256, "extracted manifest differs from producer evidence");
    assert.equal(JSON.parse(bytes).files.length, record.package.files);
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, job, directory, packageDirectory] = process.argv.slice(2);
  if (command === "record") await record(job, directory, packageDirectory);
  else if (command === "verify") await verifyProducerEvidence(job, await context());
  else if (command === "operator") await verifyOperatorPackage(job, (await context()).commit);
  else if (command === "unpacked") await verifyUnpacked(job, directory);
  else throw new Error("Unknown evidence command");
}
