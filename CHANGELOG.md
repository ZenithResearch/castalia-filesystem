# Changelog

## Unreleased

Extract the existing portable filesystem core and browser WASM bridge into maintained source, retaining AGPL attribution, canonical v1 bytes, original tests and reviewed locks. Add locked native/actual-WASM checks and independently verified candidate package inventories so consumers can pin a source commit and artifact digest without importing fork history or publishing a registry package.

Remap Cargo and installed rust-src compiler paths as well as checkout paths, and compare complete Linux/macOS candidate manifests in CI. This repairs proven cross-host WASM/closure differences while retaining strict independent source and artifact digest checks.

Declare macOS arm64 as the canonical package build host and compare two independent hosted builders. Preserve Linux portability checks. Record the published wasm-bindgen CLI lock and reject a mismatched walrus producer without removing producer metadata; `--version` alone did not distinguish an unlocked local CLI build.
