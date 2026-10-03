# Immutable review candidates

Commit source first, then build from that clean commit. The build checks Node 24.18.0, Rust nightly-2026-06-21, wasm-pack 0.14.0 and wasm-bindgen-cli 0.2.127. Locked metadata checks run before wasm-pack, because wasm-pack's own metadata phase can otherwise repair a stale lock before Cargo receives `--locked`.

Both native and standalone WASM locks are reviewed inputs. Ordinary verification never regenerates them. WASM compilation is locked and offline after an explicit locked dependency fetch. Web and Node bindings are built separately, and the preserved parity script exercises the actual Node WASM package.

Only the optional WASM `name` debug section is removed, matching the historical browser artifact normalization. Executable sections are not rewritten. The generated package inventory records exact bytes and sizes, source revision, dirty status, compiler/binding versions and lock hashes. Generated packages are marked private to prevent accidental npm publication.

The package manifest excludes itself from its file inventory; its SHA-256 is recorded independently. The source commit does not contain its own SHA. Consumers pin that source commit and the reviewed manifest digest in their own repositories, and verify the complete package before importing generated artifacts.

CI artifacts are review transport, not a published release or a permanent download promise. Keep a verified candidate copy with the reconciliation evidence. No workflow publishes to npm, crates.io or GitHub Releases, and no workflow deploys or merges. Final release pins require later approval and merged source.

A development build can be requested explicitly for diagnosis; its dirty/development marker is rejected by normal consumer verification. Production consumers retain their own complete application-build manifests and Chrome, staging and private-archive acceptance gates.

The browser-registration candidate extends the complete inventory with runtime ESM source/declarations, root package metadata, exact npm lock, registration/adapter docs, source provenance and the ZIP dependency license. The same manifest binds these files and both generated WASM targets to one source commit. The original Stage 1 branch and its candidate package remain immutable. Build tools still require Node 24.18.0; the dependency-free registration entry also supports the already tested Node 20.20.0 Wallet runtime.

Canonical package reproducibility is checked on two independent macOS arm64 runners. Compilation remaps checkout, Cargo-home and installed rust-src paths before code generation; postprocessing still removes only the optional WASM name section. This corrects host-specific panic paths and generated closure identifiers, without weakening exact package verification. Both hosted manifests must match completely. Native Linux checks and wasm32 compilation remain portability checks; cross-OS Rust closure symbols are not byte-stable and are not rewritten. Matching two checkouts on one machine alone does not establish cross-host reproducibility.

The canonical compiler host is `aarch64-apple-darwin`. Install `wasm-bindgen-cli` 0.2.127 with its published `--locked` dependencies; its copied lock and installation provenance are committed under `provenance/`. The builder inspects the preserved WASM producers section and rejects a mismatched walrus processor (expected 0.26.4), even when the CLI reports the same top-level version.

The complete package also includes source provenance, distribution-review guidance and exact third-party notice texts. `provenance/notices.json` checks copied text/slice hashes against the reviewed dependency locks; it does not decide ownership or legal compatibility. Notice-only changes invalidate the complete package digest and therefore require updated consumer pins even when WASM bytes remain identical.
