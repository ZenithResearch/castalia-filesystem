#!/usr/bin/env bash
set -euo pipefail
umask 077
cd "$(dirname "$0")/.."

gate="${1:?source gate required}"
case "$gate" in native|wasm|ready) ;; *) echo 'unknown source gate' >&2; exit 2 ;; esac
[[ "${BUILDKITE:-}" == true ]] || { echo 'Buildkite execution context required' >&2; exit 1; }
[[ "${BUILDKITE_COMMIT:-}" =~ ^[0-9a-f]{40}$ ]] || { echo 'Immutable Buildkite commit required' >&2; exit 1; }
[[ "$(git rev-parse HEAD)" == "$BUILDKITE_COMMIT" ]] || { echo 'Checkout does not match requested commit' >&2; exit 1; }
[[ -z "$(git status --porcelain --untracked-files=all)" ]] || { echo 'Clean checkout required' >&2; exit 1; }
[[ "$(uname -s)/$(uname -m)" == Linux/x86_64 ]] || { echo 'Linux x64 gate required' >&2; exit 1; }

if [[ "$gate" == ready ]]; then
  git diff --exit-code
  git diff --cached --exit-code
  exit 0
fi

CI_TEMP="$(mktemp -d "${TMPDIR:-/tmp}/castalia-files-local-ci.XXXXXXXX")"
export CI_TEMP
trap 'rm -rf "$CI_TEMP"' EXIT
source .buildkite/scripts/bootstrap.sh
ci_bootstrap

case "$gate" in
  native)
    node --test .buildkite/tests/ci.test.mjs
    node --test tests/*.test.mjs
    node scripts/verify-extraction.mjs
    cargo fetch --locked
    cargo test --workspace --all-targets --locked --offline
    cargo clippy --workspace --all-targets --locked --offline -- -D warnings
    cargo fmt --all -- --check
    cargo fmt --manifest-path castalia-filesystem-wasm/Cargo.toml -- --check
    cargo check -p castalia-filesystem-core --target wasm32-unknown-unknown --locked --offline
    ;;
  wasm)
    cargo install wasm-pack --version 0.14.0 --locked
    cargo install wasm-bindgen-cli --version 0.2.127 --locked
    cargo fetch --manifest-path castalia-filesystem-wasm/Cargo.toml --locked
    wasm-pack build castalia-filesystem-wasm --target nodejs --release --mode no-install --no-opt --out-dir "$CI_TEMP/node-pkg" -- --locked
    node castalia-filesystem-wasm/tests/parity.mjs "$CI_TEMP/node-pkg"
    ;;
esac
