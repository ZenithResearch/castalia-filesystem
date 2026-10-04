import assert from "node:assert/strict";
import test from "node:test";
import { readFile, writeFile, mkdir, mkdtemp, rm, symlink, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { CHECKS, validateEvidence, verifyProducerEvidence, verifyOperatorPackage } from "../scripts/evidence.mjs";

const ctx = { commit: "a".repeat(40), tree: "b".repeat(40), buildId: "synthetic-build", locks: { "Cargo.lock": "c".repeat(64) } };
function evidence(job) {
  const apple = job !== "linux" && job !== "compare";
  return { schema: "castalia.filesystem.buildkite-job.v1", job, status: "passed", ...structuredClone(ctx), jobId: `synthetic-${job}`, checks: [...CHECKS[job]], tools: { node: "v24.18.0", platform: apple ? "darwin" : "linux", arch: apple ? "arm64" : "x64", rustToolchain: "nightly-2026-06-21", rustc: "synthetic compiler identity", cargo: "synthetic cargo identity", wasmPack: "wasm-pack 0.14.0", wasmBindgen: "wasm-bindgen 0.2.127" }, package: { manifestSha256: "d".repeat(64), archiveSha256: "e".repeat(64), files: 1 } };
}

test("pipeline routes every macOS job through the exact-commit approval block", async () => {
  // JSON is a strict YAML subset; no new YAML parser dependency is needed.
  const pipeline = JSON.parse(await readFile(new URL("../pipeline.yml", import.meta.url), "utf8"));
  const steps = new Map(pipeline.steps.map(step => [step.key, step]));
  assert.equal(steps.size, 6);
  const block = steps.get("filesystem-authorize-macos");
  assert.match(block.block, /Authorize billed macOS/);
  assert.deepEqual(block.depends_on, ["filesystem-linux"]);
  assert.equal(block.fields[0].key, "filesystem-macos-approved-commit");
  assert.equal(block.fields[0].required, true);
  for (const key of ["filesystem-mac-native", "filesystem-candidate-one", "filesystem-candidate-two"]) {
    assert.equal(steps.get(key).agents.queue, "macos-15-medium");
    assert.deepEqual(steps.get(key).depends_on, ["filesystem-authorize-macos"]);
  }
  const final = steps.get("filesystem-qualified");
  assert.equal(final.agents.queue, "linux-small");
  assert.deepEqual(final.depends_on, ["filesystem-linux", "filesystem-mac-native", "filesystem-candidate-one", "filesystem-candidate-two"]);
  for (const step of pipeline.steps) {
    assert.equal(step.soft_fail, undefined);
    assert.equal(step.allow_dependency_failure, undefined);
    assert.equal(step.skip, undefined);
    assert.equal(step.if, undefined);
    assert.equal(step.trigger, undefined);
  }
});

test("completion receipts reject missing/skipped checks, wrong builds, stale source and altered locks", () => {
  for (const job of Object.keys(CHECKS)) assert.doesNotThrow(() => validateEvidence(evidence(job), job, ctx));
  for (const mutate of [
    r => { r.checks.pop(); }, r => { r.checks.reverse(); }, r => { r.status = "skipped"; },
    r => { r.buildId = "old-build"; }, r => { r.commit = "0".repeat(40); },
    r => { r.tree = "0".repeat(40); }, r => { r.locks["Cargo.lock"] = "0".repeat(64); },
    r => { r.tools.arch = "x64"; }, r => { r.tools.node = "v24.19.0"; },
    r => { r.tools.wasmBindgen = "wasm-bindgen 0.2.128"; }, r => { r.jobId = ""; },
  ]) {
    const record = evidence("candidate-one"); mutate(record);
    assert.throws(() => validateEvidence(record, "candidate-one", ctx));
  }
});

test("producer binding rejects corrupted archives and one job posing as both replicas", async () => {
  const directory = await mkdtemp(join(tmpdir(), "castalia-ci-producers-"));
  try {
    for (const job of ["linux", "mac-native", "candidate-one", "candidate-two"]) {
      await mkdir(join(directory, job));
      const bytes = Buffer.from(`synthetic ${job}`); const record = evidence(job);
      if (job === "mac-native") delete record.package;
      else { record.package.archiveSha256 = createHash("sha256").update(bytes).digest("hex"); await writeFile(join(directory, job, "package.tar.gz"), bytes); }
      await writeFile(join(directory, job, "job.json"), JSON.stringify(record));
    }
    await verifyProducerEvidence(directory, ctx);
    await writeFile(join(directory, "candidate-one/package.tar.gz"), "corrupt");
    await assert.rejects(verifyProducerEvidence(directory, ctx), /archive bytes changed/);
    await writeFile(join(directory, "candidate-one/package.tar.gz"), "synthetic candidate-one");
    const file = join(directory, "candidate-two/job.json"); const record = JSON.parse(await readFile(file));
    record.jobId = "synthetic-candidate-one"; await writeFile(file, JSON.stringify(record));
    await assert.rejects(verifyProducerEvidence(directory, ctx), /independent jobs/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("operator manifest binds source and the entire package, not a selected subset", async () => {
  const directory = await mkdtemp(join(tmpdir(), "castalia-ci-operator-"));
  try {
    const bytes = Buffer.from("synthetic operator file");
    const manifest = { schema: "castalia.files-services-package.v1", sourceRevision: ctx.commit, sourceDirty: false, node: "24.18.0", s3dRevision: "e468d007cfc9eefa083d09b5a858ba294f64f6cf", files: [{ path: "source.mjs", bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") }] };
    await writeFile(join(directory, "source.mjs"), bytes); await writeFile(join(directory, "manifest.json"), JSON.stringify(manifest));
    await verifyOperatorPackage(directory, ctx.commit);
    await writeFile(join(directory, "extra.mjs"), "extra"); await assert.rejects(verifyOperatorPackage(directory, ctx.commit), /inventory mismatch/); await rm(join(directory, "extra.mjs"));
    await symlink("source.mjs", join(directory, "alias.mjs")); await assert.rejects(verifyOperatorPackage(directory, ctx.commit), /symlink/); await rm(join(directory, "alias.mjs"));
    manifest.sourceDirty = true; await writeFile(join(directory, "manifest.json"), JSON.stringify(manifest)); await assert.rejects(verifyOperatorPackage(directory, ctx.commit));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("bounded extractor rejects traversal, links, duplicate paths and excess bytes before writing", () => {
  const script = new URL("../scripts/extract-package.py", import.meta.url).pathname;
  const program = `import importlib.util,io,pathlib,tarfile,tempfile,sys\nsys.dont_write_bytecode=True\nspec=importlib.util.spec_from_file_location('extractor',${JSON.stringify(script)})\nmodule=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)\nwith tempfile.TemporaryDirectory(prefix='castalia-ci-archives-') as t:\n p=pathlib.Path(t)\n for case in ['valid','traversal','symlink','hardlink','duplicate','parent','large']:\n  archive=p/(case+'.tar.gz');out=p/case\n  with tarfile.open(archive,'w:gz') as tar:\n   names=['file'] if case!='duplicate' else ['file','file']\n   if case=='parent':names=['file','file/child']\n   for name in names:\n    m=tarfile.TarInfo('../escape' if case=='traversal' else name)\n    m.size=1\n    if case in ['symlink','hardlink']:m.type=tarfile.SYMTYPE if case=='symlink' else tarfile.LNKTYPE;m.linkname='outside';m.size=0\n    if case=='large':m.size=64*1024*1024+1\n    if case=='large':tar.fileobj.write(m.tobuf());continue\n    tar.addfile(m,io.BytesIO(b'x') if m.isfile() else None)\n  if case=='valid':module.extract(archive,out);assert(out/'file').read_bytes()==b'x'\n  else:\n   try:module.extract(archive,out)\n   except (ValueError,tarfile.ReadError):pass\n   else:raise AssertionError(case)\n   assert not out.exists(),case\n`;
  const result = spawnSync("python3", ["-c", program], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stdout + result.stderr);
});

test("wrapper fails before tool acquisition without an authenticated immutable build context", () => {
  const script = new URL("../scripts/run.sh", import.meta.url).pathname;
  for (const extra of [{ BUILDKITE: "false" }, { BUILDKITE: "true", BUILDKITE_COMMIT: "HEAD" }, { BUILDKITE: "true", BUILDKITE_COMMIT: "0".repeat(40) }]) {
    const result = spawnSync("bash", [script, "linux"], { env: { ...process.env, ...extra }, encoding: "utf8" });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Buildkite execution context required|Immutable Buildkite commit required|Checkout does not match/);
  }
});


test("macOS rejects a different approved commit before acquiring tools", async () => {
  const directory = await mkdtemp(join(tmpdir(), "castalia-ci-approval-"));
  try {
    const programs = {
      git: `#!/bin/sh\nif [ "$1" = rev-parse ]; then printf '%s\\n' '${ctx.commit}'; fi\n`,
      uname: '#!/bin/sh\nif [ "$1" = -s ]; then echo Darwin; else echo arm64; fi\n',
      "buildkite-agent": '#!/bin/sh\necho 0000000000000000000000000000000000000000\n',
      curl: '#!/bin/sh\necho UNEXPECTED_TOOL_ACQUISITION >&2\nexit 77\n',
    };
    for (const [name, bytes] of Object.entries(programs)) {
      await writeFile(join(directory, name), bytes); await chmod(join(directory, name), 0o700);
    }
    const result = spawnSync("bash", [new URL("../scripts/run.sh", import.meta.url).pathname, "candidate-one"], {
      env: { ...process.env, PATH: `${directory}:${process.env.PATH}`, BUILDKITE: "true", BUILDKITE_COMMIT: ctx.commit }, encoding: "utf8",
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Exact-commit macOS authorization missing/);
    assert.doesNotMatch(result.stderr, /UNEXPECTED_TOOL_ACQUISITION/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("bootstrap refuses incorrect distribution bytes before execution", async () => {
  const directory = await mkdtemp(join(tmpdir(), "castalia-ci-checksum-"));
  try {
    const curl = join(directory, "curl");
    await writeFile(curl, '#!/bin/sh\nwhile [ "$#" -gt 0 ]; do if [ "$1" = --output ]; then shift; printf synthetic > "$1"; exit 0; fi; shift; done\nexit 1\n');
    await chmod(curl, 0o700);
    const expected = createHash("sha256").update("synthetic").digest("hex");
    for (const [hash, success] of [[expected, true], ["0".repeat(64), false]]) {
      const result = spawnSync("bash", ["-c", 'source "$1"; ci_fetch_verified https://invalid.test/archive "$2" "$3"', "checksum-test", new URL("../scripts/bootstrap.sh", import.meta.url).pathname, join(directory, "archive"), hash], {
        env: { ...process.env, PATH: `${directory}:${process.env.PATH}` }, encoding: "utf8",
      });
      assert.equal(result.status === 0, success, result.stderr);
      if (!success) assert.match(result.stderr, /Checksum mismatch/);
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});
