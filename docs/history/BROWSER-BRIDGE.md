# Castalia filesystem browser bridge

This standalone crate depends on the portable `castalia-filesystem-core` but
does not share the Dregg root workspace's broad dependency graph. It exposes
the existing v1 manifest codec, a bounded generation-zero producer,
single-file copy-on-write revisions and the root-pinned reader to a browser Worker. No
wire fields or persisted format were changed. Its `get_object(id, max_bytes)`
callback may return a `Uint8Array` or a Promise of one. The callback **must**
check storage record size before reading bytes into memory; the bridge checks
length and BLAKE3 ID again. The producer accepts one file at a time and bounded
chunks; its `put_object(bytes)` callback must durably store exact bytes and
return their ID. `list` and `stat` return serialized JSON; `read_range`
returns bytes. Callback rejections carrying a recognized `code` preserve
missing-object, oversized/integrity, quota and storage-unavailable distinctions
across the bridge; unknown callback failures remain generic provider errors.
`validate_tree_bounded` adds a host-selected logical file-byte ceiling while
verifying metadata; it does not change v1 manifest bytes or read file payloads.

Build a web package with a compatible `wasm-bindgen` CLI installed:

```text
wasm-pack build castalia-filesystem-wasm --target web --release --mode no-install --no-opt
```

The package lock pins the Rust binding version; a clean build must pin the
`wasm-bindgen-cli` version to the matching value. For a Node/WASM parity test:

```text
wasm-pack build castalia-filesystem-wasm --target nodejs --release --mode no-install --no-opt --out-dir /private/tmp/castalia-fs-test-package
node castalia-filesystem-wasm/tests/parity.mjs /private/tmp/castalia-fs-test-package
```

The Web repo's bounded callbacks live under `apps/web/src/files/`. A generated
web package is now checked in there and digest-verified during its app build,
so a sibling worktree path is not a Web build dependency. Its source was not
yet generated from a reviewable, pinned Git revision; see the Web package's
`PROVENANCE.md` before treating it as a release artifact.
