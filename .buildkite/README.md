# Native Buildkite filesystem checks

This pipeline preserves the checks in `.github/workflows/ci.yml` and
`services.yml`. It does not use the GitHub Actions compatibility runner, deploy,
publish packages, start services against real accounts, or run vulnerability
audits. The existing GitHub workflows remain intact.

The pipeline file uses JSON syntax, a YAML subset, so its approval/dependency
contract is testable using Node built-ins without another parser dependency.

## Execution and approval

The account bootstrap loads `buildkite-agent pipeline upload .buildkite/pipeline.yml`.
Repository linking, trigger settings and required checks are separate account
configuration. This commit does not start a build or change those settings.

1. `filesystem-linux` runs browser Node tests, the retained adapter regressions,
   declarations, extraction/source checks, both Rust formatting checks, locked
   native tests/Clippy/wasm32 compilation, full service tests, and two operator
   package builds with byte comparison and packaged tests.
2. `filesystem-authorize-macos` remains blocked until a maintainer explicitly
   authorizes billed macOS execution and enters this build's exact commit.
3. Only after that block may `filesystem-mac-native` and the two candidate
   replicas dispatch to `macos-15-medium`. Each rechecks approval before tool
   acquisition. The replicas have separate job-private Cargo/tool/output homes;
   no compiled target directory is shared.
4. `filesystem-qualified` downloads outputs by exact producer step and current
   build. It requires all four successful producer receipts at the same commit,
   tree and lock hashes, rejects duplicate job identities or altered archives,
   safely extracts bounded regular files, verifies the full operator inventory,
   and invokes the existing complete WASM package comparison.

A green Linux job is not complete macOS/WASM qualification. Until the block is
approved, the full pipeline stays blocked. No condition, soft-failure or
allow-failed-dependency option bypasses a required gate. Queue access and who may
unblock builds must be restricted to authorized maintainers in Buildkite; a YAML
block is an operational approval gate, not isolation from malicious pipeline code.

## Runner contract

Linux jobs use the existing `linux-small` queue (x86-64, 2 CPUs/4 GiB); Cargo uses
one job. macOS jobs require the existing native Apple Silicon `macos-15-medium`
queue. No queues, agents or machines are provisioned by this configuration.

Provide Bash, Git, curl and tar. On hosted Ubuntu, missing C compiler/Python
prerequisites are installed through noninteractive apt-get (root or passwordless
sudo); missing installation privileges fail closed. Native macOS requires the
Apple compiler tools already installed. Linux wrapper tests and artifact
comparison use Python 3.
Node **24.18.0** and Rustup **1.28.2** are downloaded into disposable job-private
directories and verified before execution against the checksums in
`scripts/bootstrap.sh`. Rust **nightly-2026-06-21** is installed with rustfmt,
Clippy and wasm32. Candidate jobs install wasm-pack **0.14.0** and wasm-bindgen
**0.2.127** using their published locked dependencies. Existing package tooling
also validates binding producer metadata, locked metadata, normalized compiler
paths, tool versions, source cleanliness and unchanged lockfiles.

Checksum sources, read on 2026-10-04 UTC:

- `https://nodejs.org/dist/v24.18.0/SHASUMS256.txt`
- `https://static.rust-lang.org/rustup/archive/1.28.2/x86_64-unknown-linux-gnu/rustup-init.sha256`
- `https://static.rust-lang.org/rustup/archive/1.28.2/aarch64-apple-darwin/rustup-init.sha256`

Provision an isolated clean checkout per job. Do not attach account credentials,
real wallet files, shared writable tool caches or deployment secrets to these
queues. The scripts record selected build/tool identities rather than dumping
the environment. Git checkout read access and Buildkite artifact/metadata access
are the only integration authority required.

## Evidence and scope

Logs, completed-check lists and success-only `job.json` receipts live beneath
ignored `.buildkite/artifacts/<gate>/`. Candidate and operator packages are
archived with all their files, including notice/provenance material. Receipts
bind each archive digest to its complete package manifest, source and job.
The comparison output retains both final manifests. Keep the original producer
archives and logs under the account's configured artifact retention policy;
this YAML does not silently impose or promise a retention duration.

Package outputs remain review candidates. Passing CI does not resolve inherited
source permissions or establish production issuer, registration, browser,
funded Sia, native bridge, staging or deployment acceptance. No protocol, storage,
recovery or dependency lock format changes are part of this pipeline.

Local wrapper validation (no tool downloads or compilations):

```sh
bash -n .buildkite/scripts/bootstrap.sh .buildkite/scripts/run.sh
node --test .buildkite/tests/*.test.mjs
```
