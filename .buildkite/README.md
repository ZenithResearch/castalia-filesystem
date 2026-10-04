# Filesystem source checks on Buildkite

The account bootstrap verifies `git rev-parse HEAD` equals `BUILDKITE_COMMIT`
and uploads this branch's `.buildkite/pipeline.yml`. The pipeline has exactly
three steps on `linux-medium`: locked native/source/services checks, an actual
Node-target WASM build with golden-fixture parity, and a readiness step that
depends on both. It contains no macOS source jobs, approval block, release
publishing, deployment step, or storage credentials. The old Buildkite pipeline
and its failed build remain available with incoming webhooks disabled.

Each gate checks an immutable, clean checkout before installing tools. The
bootstrap verifies pinned Node 24.18.0 and Rustup 1.28.2 downloads, then
installs nightly-2026-06-21. The WASM gate installs locked wasm-pack 0.14.0 and
wasm-bindgen-cli 0.2.127 and tests the actual compiled Node package. This is
Linux portability and fixture parity, **not** two-builder macOS package-byte
reproducibility. Existing GitHub Actions workflows retain their own checks.

Configure GitHub PR/main triggers and commit statuses on the separate
`castalia-filesystem-source` pipeline linked to
`ZenithResearch/castalia-filesystem`; do not enable workflow-authorized GitHub
tokens or attach deployment secrets. Buildkite jobs require Git checkout read
access and an agent on the `linux-medium` queue. No production promotion is
authorized by a green CI build.

Local contract checks, without downloads:

```sh
bash -n .buildkite/scripts/bootstrap.sh .buildkite/source-gates.sh
node --test .buildkite/tests/ci.test.mjs
```
