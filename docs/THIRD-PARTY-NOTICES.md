# Third-party notice inventory

The copied notice texts below retain every recorded upstream license option; no alternate license is selected or new permission asserted. `provenance/notices.json` records exact source versions, registry checksums, notice-file hashes and byte ranges. Public records contain no private review evidence or local cache paths.

The 24 runtime entries are the default wasm32 dependency graph with build/proc-macro paths separated. They are potential inputs, not proof that every crate survives linking. The generated-binding source and the walrus processor are explicitly distinguished; build tools are not shipped executables. Optional native/FUSE and unrelated development-tool closures are outside this browser payload. A native distribution requires its own inventory.

| Component | Declared terms | Scope |
|---|---|---|
| arrayvec 0.7.8 | MIT OR Apache-2.0 | potential-wasm-runtime |
| blake3 1.8.7 | CC0-1.0 OR Apache-2.0 OR Apache-2.0 WITH LLVM-exception | potential-wasm-runtime |
| cfg-if 1.0.5 | MIT OR Apache-2.0 | potential-wasm-runtime |
| constant_time_eq 0.4.2 | CC0-1.0 OR MIT-0 OR Apache-2.0 | potential-wasm-runtime |
| futures-channel 0.3.34 | MIT OR Apache-2.0 | potential-wasm-runtime |
| futures-core 0.3.34 | MIT OR Apache-2.0 | potential-wasm-runtime |
| futures-io 0.3.34 | MIT OR Apache-2.0 | potential-wasm-runtime |
| futures-sink 0.3.34 | MIT OR Apache-2.0 | potential-wasm-runtime |
| futures-task 0.3.34 | MIT OR Apache-2.0 | potential-wasm-runtime |
| futures-util 0.3.34 | MIT OR Apache-2.0 | potential-wasm-runtime |
| itoa 1.0.18 | MIT OR Apache-2.0 | potential-wasm-runtime |
| js-sys 0.3.104 | MIT OR Apache-2.0 | potential-wasm-runtime |
| memchr 2.8.3 | Unlicense OR MIT | potential-wasm-runtime |
| once_cell 1.21.4 | MIT OR Apache-2.0 | potential-wasm-runtime |
| pin-project-lite 0.2.17 | Apache-2.0 OR MIT | potential-wasm-runtime |
| serde 1.0.229 | MIT OR Apache-2.0 | potential-wasm-runtime |
| serde_core 1.0.229 | MIT OR Apache-2.0 | potential-wasm-runtime |
| serde_json 1.0.151 | MIT OR Apache-2.0 | potential-wasm-runtime |
| slab 0.4.12 | MIT | potential-wasm-runtime |
| unicode-ident 1.0.26 | (MIT OR Apache-2.0) AND Unicode-3.0 | potential-wasm-runtime |
| walrus 0.26.4 | MIT/Apache-2.0 | build-tool-only |
| wasm-bindgen 0.2.127 | MIT OR Apache-2.0 | potential-wasm-runtime |
| wasm-bindgen-cli-support 0.2.127 | MIT OR Apache-2.0 | generated-binding-source |
| wasm-bindgen-futures 0.4.77 | MIT OR Apache-2.0 | potential-wasm-runtime |
| wasm-bindgen-shared 0.2.127 | MIT OR Apache-2.0 | potential-wasm-runtime |
| zmij 1.0.23 | MIT | potential-wasm-runtime |

All crate notice texts are in `licenses/cargo-runtime-notices.txt`. The exact compiler-provided standard-library copyright report is `licenses/rust-standard-library.html`; it intentionally covers a broader library than the subset potentially linked into WASM. Both documents are bound by the notice index.

Binding generation remains wasm-bindgen 0.2.127 with its locked walrus 0.26.4. The complete build manifest retains the exact Rust commit/tool versions and preserved WASM producers. The notice index does not claim a per-symbol source map or resolve source ownership.

Missing permission evidence for inherited browser/Wallet material, where present in a later adapter candidate, remains separate from these cached third-party declarations.

The Stage 2 browser adapter additionally imports the exact `@zip.js/zip.js` 2.18.2 native-compression entry. Its BSD-3-Clause notice is retained in `licenses/zip-js-BSD-3-Clause.txt`, and its version/integrity are fixed in package metadata and the unchanged npm lock. ZIP dependency files are resolved by the consumer; they are not copied into this source package or into the Wallet registration entry. Existing Web-derived runtime and test origin evidence is separate from this ZIP notice.
