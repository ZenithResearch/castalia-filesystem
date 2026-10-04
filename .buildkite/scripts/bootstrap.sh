#!/usr/bin/env bash
# Sourced by source-gates.sh. All installations belong to this disposable job.
set -euo pipefail

ci_fetch_verified() {
  local url="$1" output="$2" expected="$3" actual
  curl --fail --location --silent --show-error --retry 3 "$url" --output "$output"
  if command -v sha256sum >/dev/null; then
    actual="$(sha256sum "$output")"
  else
    actual="$(shasum -a 256 "$output")"
  fi
  actual="${actual%% *}"
  [[ "$actual" == "$expected" ]] || { printf 'Checksum mismatch: %s\n' "$url" >&2; return 1; }
}

ci_bootstrap() {
  for tool in git curl tar cc; do
    command -v "$tool" >/dev/null || { printf 'Missing runner prerequisite: %s\n' "$tool" >&2; return 1; }
  done
  [[ "$(uname -s)/$(uname -m)" == Linux/x86_64 ]] || { echo 'Linux x64 gate required' >&2; return 1; }
  ci_fetch_verified \
    'https://nodejs.org/dist/v24.18.0/node-v24.18.0-linux-x64.tar.gz' \
    "$CI_TEMP/node.tar.gz" \
    '783130984963db7ba9cbd01089eaf2c2efb055c7c1693c943174b967b3050cb8'
  mkdir "$CI_TEMP/node"
  tar -xzf "$CI_TEMP/node.tar.gz" --strip-components=1 -C "$CI_TEMP/node"
  export PATH="$CI_TEMP/node/bin:$PATH"
  [[ "$(node --version)" == v24.18.0 ]] || return 1

  export CARGO_HOME="$CI_TEMP/cargo" RUSTUP_HOME="$CI_TEMP/rustup"
  export CARGO_TARGET_DIR="$CI_TEMP/target" CARGO_BUILD_JOBS=1
  export RUSTUP_TOOLCHAIN=nightly-2026-06-21
  ci_fetch_verified \
    'https://static.rust-lang.org/rustup/archive/1.28.2/x86_64-unknown-linux-gnu/rustup-init' \
    "$CI_TEMP/rustup-init" \
    '20a06e644b0d9bd2fbdbfd52d42540bdde820ea7df86e92e533c073da0cdd43c'
  chmod 700 "$CI_TEMP/rustup-init"
  "$CI_TEMP/rustup-init" -y --no-modify-path --profile minimal --default-toolchain none
  export PATH="$CARGO_HOME/bin:$PATH"
  rustup toolchain install nightly-2026-06-21 --profile minimal --component rustfmt --component clippy --target wasm32-unknown-unknown
}
