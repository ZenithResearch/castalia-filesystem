#!/usr/bin/env bash
# Sourced by run.sh. All installations belong to this disposable job.
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

ci_prerequisites() {
  local mode="$1"
  for tool in git curl tar; do
    command -v "$tool" >/dev/null || { printf 'Missing runner prerequisite: %s\n' "$tool" >&2; return 1; }
  done
  if [[ "$(uname -s)" == Linux ]]; then
    local missing=false
    command -v python3 >/dev/null || missing=true
    if [[ "$mode" != compare ]]; then command -v cc >/dev/null || missing=true; fi
    if [[ "$missing" == true ]]; then
      command -v apt-get >/dev/null || { printf 'Ubuntu apt-get required to supply compiler/Python prerequisites\n' >&2; return 1; }
      local privilege=()
      if [[ "$(id -u)" != 0 ]]; then privilege=(sudo -n); fi
      "${privilege[@]}" apt-get update
      "${privilege[@]}" apt-get install -y --no-install-recommends build-essential python3
    fi
  else
    command -v cc >/dev/null || { printf 'Apple compiler tools required\n' >&2; return 1; }
  fi
}

ci_bootstrap() {
  ci_prerequisites "$1"
  local mode="$1" node_platform node_hash rust_platform rust_hash
  case "$(uname -s)/$(uname -m)" in
    Linux/x86_64)
      node_platform=linux-x64
      node_hash=783130984963db7ba9cbd01089eaf2c2efb055c7c1693c943174b967b3050cb8
      rust_platform=x86_64-unknown-linux-gnu
      rust_hash=20a06e644b0d9bd2fbdbfd52d42540bdde820ea7df86e92e533c073da0cdd43c
      ;;
    Darwin/arm64)
      node_platform=darwin-arm64
      node_hash=e1a97e14c99c803e96c7339403282ea05a499c32f8d83defe9ef5ec66f979ed1
      rust_platform=aarch64-apple-darwin
      rust_hash=20ef5516c31b1ac2290084199ba77dbbcaa1406c45c1d978ca68558ef5964ef5
      ;;
    *) printf 'Unsupported CI host\n' >&2; return 1 ;;
  esac
  ci_fetch_verified "https://nodejs.org/dist/v24.18.0/node-v24.18.0-${node_platform}.tar.gz" "$CI_TEMP/node.tar.gz" "$node_hash"
  mkdir "$CI_TEMP/node"
  tar -xzf "$CI_TEMP/node.tar.gz" --strip-components=1 -C "$CI_TEMP/node"
  export PATH="$CI_TEMP/node/bin:$PATH"
  [[ "$(node --version)" == v24.18.0 ]] || return 1
  export npm_config_cache="$CI_TEMP/npm-cache"
  export npm_config_audit=false npm_config_fund=false
  if [[ "$mode" == compare ]]; then return; fi

  export CARGO_HOME="$CI_TEMP/cargo" RUSTUP_HOME="$CI_TEMP/rustup"
  export CARGO_TARGET_DIR="$CI_TEMP/target" CARGO_BUILD_JOBS=1
  export RUSTUP_TOOLCHAIN=nightly-2026-06-21
  ci_fetch_verified "https://static.rust-lang.org/rustup/archive/1.28.2/${rust_platform}/rustup-init" "$CI_TEMP/rustup-init" "$rust_hash"
  chmod 700 "$CI_TEMP/rustup-init"
  "$CI_TEMP/rustup-init" -y --no-modify-path --profile minimal --default-toolchain none
  export PATH="$CARGO_HOME/bin:$PATH"
  rustup toolchain install nightly-2026-06-21 --profile minimal --component rustfmt --component clippy --target wasm32-unknown-unknown
}
