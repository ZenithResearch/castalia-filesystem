# Stage 1 validation

Local macOS checks use Node 24.18.0, rustc 1.98.0-nightly (8b6558a02 2026-06-20), the nightly-2026-06-21 toolchain, wasm-pack 0.14.0 and wasm-bindgen-cli 0.2.127.

The extracted source passes all 31 native tests, strict Clippy, Rust formatting for both workspaces and wasm32 compilation. Ten Node checks exercise complete artifact inventories, byte tampering, unexpected files/symlinks, source pins, unknown schema/tool fields, development rejection, private generated metadata, real Cargo missing/stale lock rejection and limited WASM normalization.

Actual Node WASM parity passes the unchanged canonical manifest, snapshot construction, pinned reads, revisions, resource bounds, quota/missing-object and tamper cases. The web JS, declarations and normalized executable WASM match the existing reviewed Web artifacts byte-for-byte:

| File | SHA-256 |
| --- | --- |
| castalia_filesystem_wasm.js | 1ac1c790b1462c36ee057d38e2126dd4c3c945c11c39e9cebba838ac2800b875 |
| castalia_filesystem_wasm.d.ts | ab00661f57baeff14e8f281e4e193b8f2dc2311b140f7b26717ba117d9ac03db |
| castalia_filesystem_wasm_bg.wasm | c4ade8b4bab2e75c6821280add534ad9c2eb07c16e3164879bf071c053b49b7f |

Generated package metadata intentionally changes to identify this maintained repository, prohibit registry publication and bind the source commit. The package manifest records its resulting digest. Exact committed candidate identity and final package-manifest SHA are produced externally by the clean-source build and recorded in the PR/evidence; they are not self-referential source constants.

CI repeats native checks on Linux and macOS and builds an actual-WASM candidate. These library checks do not qualify organisation registration, browser storage, native save dialogs, private archive acceptance, hosted staging or production deployment.
