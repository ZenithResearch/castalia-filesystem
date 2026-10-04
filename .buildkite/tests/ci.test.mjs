import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";

const pipelineUrl = new URL("../pipeline.yml", import.meta.url);
const runnerUrl = new URL("../source-gates.sh", import.meta.url);

test("source pipeline contains only Linux native, WASM, and readiness gates", async () => {
  // JSON is a strict YAML subset; parsing needs no added dependency.
  const pipeline = JSON.parse(await readFile(pipelineUrl, "utf8"));
  assert.deepEqual(pipeline.steps.map(({ key }) => key), ["native", "wasm", "filesystem-source-ready"]);
  for (const step of pipeline.steps) {
    assert.equal(step.agents.queue, "linux-medium");
    assert.match(step.command, /^bash \.buildkite\/source-gates\.sh (native|wasm|ready)$/);
    for (const forbidden of ["block", "trigger", "if", "skip", "soft_fail", "allow_dependency_failure", "artifact_paths"])
      assert.equal(step[forbidden], undefined);
  }
  assert.deepEqual(pipeline.steps[2].depends_on, ["native", "wasm"]);
  assert.doesNotMatch(JSON.stringify(pipeline), /macos|run\.sh|deploy|secret/i);
});

test("source runner refuses unauthenticated or mismatched commits before tool bootstrap", async () => {
  const runner = await readFile(runnerUrl, "utf8");
  assert.ok(runner.indexOf("git rev-parse HEAD") < runner.indexOf("ci_bootstrap"));
  assert.ok(runner.indexOf("git status --porcelain") < runner.indexOf("ci_bootstrap"));
  for (const env of [
    { BUILDKITE: "false" },
    { BUILDKITE: "true", BUILDKITE_COMMIT: "HEAD" },
    { BUILDKITE: "true", BUILDKITE_COMMIT: "0".repeat(40) },
  ]) {
    const result = spawnSync("bash", [runnerUrl.pathname, "native"], {
      env: { ...process.env, ...env }, encoding: "utf8",
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Buildkite execution context required|Immutable Buildkite commit required|Checkout does not match/);
  }
});

test("WASM gate pins binding tools and runs the actual golden-fixture parity suite", async () => {
  const runner = await readFile(runnerUrl, "utf8");
  assert.match(runner, /wasm-pack --version 0\.14\.0 --locked/);
  assert.match(runner, /wasm-bindgen-cli --version 0\.2\.127 --locked/);
  assert.match(runner, /wasm-pack build castalia-filesystem-wasm --target nodejs/);
  assert.match(runner, /node castalia-filesystem-wasm\/tests\/parity\.mjs/);
});
