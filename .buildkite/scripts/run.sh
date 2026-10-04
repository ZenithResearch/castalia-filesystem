#!/usr/bin/env bash
set -euo pipefail
umask 077
cd "$(dirname "$0")/../.."
mode="${1:-}"
case "$mode" in linux|mac-native|candidate-one|candidate-two|compare) ;; *) printf 'Unknown CI gate\n' >&2; exit 2 ;; esac
[[ "${BUILDKITE:-}" == true ]] || { printf 'Buildkite execution context required\n' >&2; exit 1; }
[[ "${BUILDKITE_COMMIT:-}" =~ ^[0-9a-f]{40}$ ]] || { printf 'Immutable Buildkite commit required\n' >&2; exit 1; }
[[ "$(git rev-parse HEAD)" == "$BUILDKITE_COMMIT" ]] || { printf 'Checkout does not match requested commit\n' >&2; exit 1; }
[[ -z "$(git status --porcelain --untracked-files=all)" ]] || { printf 'Clean checkout required\n' >&2; exit 1; }
if [[ "$mode" == mac-native || "$mode" == candidate-* ]]; then
  [[ "$(uname -s)/$(uname -m)" == Darwin/arm64 ]] || { printf 'Native Apple Silicon required\n' >&2; exit 1; }
  approved="$(buildkite-agent meta-data get filesystem-macos-approved-commit)"
  [[ "$approved" == "$BUILDKITE_COMMIT" ]] || { printf 'Exact-commit macOS authorization missing\n' >&2; exit 1; }
else
  [[ "$(uname -s)/$(uname -m)" == Linux/x86_64 ]] || { printf 'Linux x64 gate required\n' >&2; exit 1; }
fi
artifacts="$PWD/.buildkite/artifacts/$mode"
[[ ! -e "$artifacts" ]] || { printf 'Preserve old evidence; use a fresh checkout\n' >&2; exit 1; }
mkdir -p "$artifacts/logs"
CI_TEMP="$(mktemp -d "${TMPDIR:-/tmp}/castalia-files-ci.XXXXXXXX")"
export CI_TEMP
trap 'rm -rf "$CI_TEMP"' EXIT
source .buildkite/scripts/bootstrap.sh
ci_bootstrap "$mode"
run_check() {
  local name="$1"
  shift
  "$@" 2>&1 | tee "$artifacts/logs/$name.log"
  printf '%s\n' "$name" >> "$artifacts/checks.txt"
}
native_checks() {
  run_check cargo-fetch cargo fetch --locked
  run_check extraction node scripts/verify-extraction.mjs
  run_check source-tests node --test tests/*.test.mjs
  run_check native-tests cargo test --workspace --all-targets --locked --offline
  run_check clippy cargo clippy --workspace --all-targets --locked --offline -- -D warnings
  run_check rust-format cargo fmt --all -- --check
  run_check wasm-format cargo fmt --manifest-path castalia-filesystem-wasm/Cargo.toml -- --check
  run_check wasm-check cargo check -p castalia-filesystem-core --target wasm32-unknown-unknown --locked --offline
}
case "$mode" in
  linux)
    run_check npm-lock npm ci --ignore-scripts --no-audit --no-fund
    run_check ci-contract node --test .buildkite/tests/*.test.mjs
    run_check browser-tests node --test packages/browser/tests/*.test.mjs
    run_check retained-tests npm run test:browser-retained
    run_check browser-types npm run typecheck:browser
    native_checks
    run_check services-lock npm ci --prefix services --ignore-scripts --no-audit --no-fund
    run_check services-tests node --test services/tests/*.test.mjs
    run_check operator-package-one node services/scripts/build-package.mjs "$CI_TEMP/operator-one"
    run_check operator-package-two node services/scripts/build-package.mjs "$CI_TEMP/operator-two"
    run_check operator-equality diff -qr "$CI_TEMP/operator-one" "$CI_TEMP/operator-two"
    (cd "$CI_TEMP/operator-one"; node --test services/tests/*.test.mjs) 2>&1 | tee "$artifacts/logs/packaged-services-tests.log"
    printf 'packaged-services-tests\n' >> "$artifacts/checks.txt"
    tar -czf "$artifacts/package.tar.gz" -C "$CI_TEMP/operator-one" .
    node .buildkite/scripts/evidence.mjs record "$mode" "$artifacts" "$CI_TEMP/operator-one"
    ;;
  mac-native)
    native_checks
    node .buildkite/scripts/evidence.mjs record "$mode" "$artifacts"
    ;;
  candidate-*)
    run_check wasm-pack-install cargo install wasm-pack --version 0.14.0 --locked
    run_check wasm-bindgen-install cargo install wasm-bindgen-cli --version 0.2.127 --locked
    run_check cargo-fetch cargo fetch --locked
    run_check wasm-fetch cargo fetch --manifest-path castalia-filesystem-wasm/Cargo.toml --locked
    run_check npm-lock npm ci --ignore-scripts --no-audit --no-fund
    run_check extraction node scripts/verify-extraction.mjs
    run_check immutable-package node scripts/build-package.mjs --out-dir "$CI_TEMP/candidate"
    run_check actual-wasm env FILESYSTEM_WASM_PACKAGE="$CI_TEMP/candidate" node --test packages/browser/tests/runtime-wasm.test.mjs packages/browser/tests/shipping-archive.test.mjs
    tar -czf "$artifacts/package.tar.gz" -C "$CI_TEMP/candidate" .
    node .buildkite/scripts/evidence.mjs record "$mode" "$artifacts" "$CI_TEMP/candidate"
    ;;
  compare)
    command -v python3 >/dev/null || { printf 'Python 3 required for bounded archive extraction\n' >&2; exit 1; }
    mkdir "$CI_TEMP/downloads" "$CI_TEMP/replicas"
    for producer in linux mac-native candidate-one candidate-two; do
      buildkite-agent artifact download ".buildkite/artifacts/$producer/*" "$CI_TEMP/downloads" --step "filesystem-$producer" --build "$BUILDKITE_BUILD_ID"
    done
    run_check producer-evidence node .buildkite/scripts/evidence.mjs verify "$CI_TEMP/downloads/.buildkite/artifacts"
    for replica in candidate-one candidate-two; do
      python3 .buildkite/scripts/extract-package.py "$CI_TEMP/downloads/.buildkite/artifacts/$replica/package.tar.gz" "$CI_TEMP/replicas/$replica"
    done
    python3 .buildkite/scripts/extract-package.py "$CI_TEMP/downloads/.buildkite/artifacts/linux/package.tar.gz" "$CI_TEMP/operator"
    run_check extracted-bindings node .buildkite/scripts/evidence.mjs unpacked "$CI_TEMP/downloads/.buildkite/artifacts" "$CI_TEMP"
    run_check operator-inventory node .buildkite/scripts/evidence.mjs operator "$CI_TEMP/operator"
    run_check package-equality node scripts/compare-candidate-manifests.mjs "$CI_TEMP/replicas" "$BUILDKITE_COMMIT"
    cp "$CI_TEMP/replicas/candidate-one/filesystem-package-manifest.json" "$artifacts/filesystem-package-manifest.json"
    cp "$CI_TEMP/operator/manifest.json" "$artifacts/services-package-manifest.json"
    node .buildkite/scripts/evidence.mjs record "$mode" "$artifacts"
    ;;
esac
