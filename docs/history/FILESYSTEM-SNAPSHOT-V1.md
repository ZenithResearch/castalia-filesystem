# Experimental filesystem snapshot v1

Devgraph: `castalia-fs-model-v1` and `castalia-fs-storage-import-export` under
`castalia-fs-snapshot-core`. CMS remains backlogged. This supplies a portable
read model and bounded import/export, not a mounted filesystem.

The portable portion of `castalia-filesystem-core` contains no FUSE, HTTP or
Sia dependency. Its Unix-only `native` module adds directory-fd-contained disk
storage and import/export; its Unix CLI adds clap/futures. Those dependencies
are excluded from browser WASM. `castalia-storage-client` re-exports the core
as `filesystem`. Native Rust/CLI and browser WASM share manifests and reader/
writer traits. See [storage and CLI usage](FILESYSTEM-STORAGE-IO.md).

## Objects and identity

Every object is identified by the BLAKE3 hash of its exact bytes, serialized as
64 lowercase hexadecimal characters. Raw chunks and canonical manifest bytes
use this same scheme, matching the mirror's byte-content identity. Sia object
locators and encrypted-object metadata are resolved by the Sia transport
adapter; they are not inserted into every directory entry.

A manifest has mandatory `schema_version: 1` and `node: {kind, body}`. Kinds:

- `directory`: `inode`, `modified_ms`, `entries: [{name, node}]`.
- `file`: `inode`, `modified_ms`, `executable`, `size`, `chunks: [{content, size}]`.
- `snapshot`: `namespace`, `generation`, `previous`, `root`.

A node reference has `inode`, `kind` (file/directory), and `manifest` content ID.
The root must reference a directory. Logical inodes are positive safe integers,
allocated by the writer and retained across changes/renames; content hashes
change when bytes or metadata change. Inodes must be globally unique within a
tree: v1 has no hardlinks. Namespace ID is an opaque content-ID-shaped identity,
not a key or capability. Generation zero has null predecessor; later generations
require a predecessor snapshot ID. This slice checks that shape, not historical
chain continuity, ownership, signatures or mutable-head consensus.

Directory entries are strictly sorted by UTF-8 name bytes. Producers can use
`Directory::new` to sort; decoders never repair malformed order/duplicates.
Names are case-sensitive UTF-8, 1–255 bytes, without slash, backslash, control
characters, dot or dot-dot. Unicode is preserved without normalization.
This deliberately excludes arbitrary Unix byte names. Times are nonnegative
Unix milliseconds; all u64 wire values are at most 2^53−1 for JS interoperability.

Canonical encoding is compact serde JSON in the declared struct field order,
with required fields, snake_case enum names, null predecessor and no trailing
newline. It is schema-specific, **not** arbitrary JSON canonicalization. Decode
checks byte limit, hash, strict typed parsing, validation, then exact canonical
re-encoding. Unknown/duplicate fields, whitespace variants, reordered fields,
unsafe numbers, unsupported kinds/versions and trailing data are rejected.
The fixture `castalia-filesystem-core/fixtures/empty-directory-v1.json` has a
conventional file newline that tests strip; stored canonical bytes do not.

## Pinned reads and limits

`ObjectReader::get(id, max_bytes)` is an async adapter boundary. Its implementation
must bound streaming before allocation, own authentication/decryption, and map
timeouts, cancellation and missing/offline objects to explicit errors. Futures
need not be Send so a browser Worker is supported. Native multithreaded FUSE
will need a suitable bounded runtime bridge; it must not assume this trait's
futures are Send. A provider that ignores the cap can allocate too much before
return; core validation cannot undo that, so adapter tests are a release gate.

`SnapshotView::open` pins the snapshot ID and validates its root reference.
`lookup`, `stat`, `list`, and `read_range` never follow a changing head. All
fetched manifests are hash-verified; inode/kind references must match their
target manifest. `validate_tree` checks every metadata reference and rejects
inode aliases: native/browser mount adapters must call it before exposure.
Opening alone is lazy and does not certify the entire tree or chunk availability.

Bounds: 1 MiB per manifest and chunk, 4 MiB per range-read output, 4096 directory
entries, 4096 chunks per file (at most 4 GiB), depth 64, 65,536 tree nodes/frontier,
and 4096-byte absolute paths. These conservative v1 bounds require future
versioned/paged manifests to support larger trees/files. No unbounded file read.
Range reads fetch only overlapping chunks and verify full chunk size/hash before
returning the requested slice. Empty files have zero chunks. EOF is an empty
read; crossing EOF is a short read. Oversized requests fail rather than truncate.
Invalid paths, missing entries, wrong kinds, corrupt objects and unavailable
providers remain distinguishable. A durable local CAS is available; it is not
an automatically populated or evicting remote cache.

## Compatibility and security

This is an **additive experimental contract**, not a mutation of postcard
`ReplicationManifestV1`, service-mesh namespace, or capability-backed
`DirectoryCell`. Those existing producers/consumers and stored bytes are left
unchanged. Future authenticated head coordination should compose with existing
capability/turn primitives rather than invent a competing authority model.
Filesystem schema version and replication schema version are separate.

Hash integrity is not permission, confidentiality, availability, finality, or
atomic Sia/Dregg settlement. Manifests expose names/metadata; chunks are plaintext
at this boundary. Do not send private trees through the current plaintext mirror
path. Encryption and authenticated object resolution need a reviewed adapter and
explicit policy before private remote writes. No snapshot API implicitly uploads,
deletes, commits a head, or grants access. Unlink will omit an entry from a future
root; it must not delete chunks referenced by older roots/open handles.

Delivered next slice: bounded writer, native durable CAS/import/export CLI,
budgeted snapshot copy, Sia SDK upload/pin/download adapter with durable sealed
metadata catalog, and explicitly scoped verified fallback composition. Existing
Dregg mirror queue/receipt APIs are unchanged; no automatic fallback transport
or receipt-verifier is wired into the CLI.

Not delivered: journal, authenticated head CAS, history verification, private
remote publication/key custody, automatic remote cache, qualified kernel FUSE
mounts, OPFS UI, symlinks, full POSIX permissions/xattrs/ACLs, or production
deployment. A local read-only FUSE adapter exists behind an optional feature; see
[adapter and runtime qualification gates](FILESYSTEM-READONLY-FUSE.md).
Kernel mounting remains unqualified. Writes require separate crash/privacy/authority gates.

## Verification

Use `cargo nextest run -p castalia-filesystem-core` for focused native tests;
check `cargo check -p castalia-filesystem-core --target wasm32-unknown-unknown`
and the storage-client re-export on native/WASM. Tests exercise canonical producer
and strict decoder, nested reads/all small range boundaries, pinned revisions,
tampering, aliases, absent refs, malicious paths and bounded invalid documents.
These are runtime Rust checks, not a new formal-verification claim.

Runnable offline producer/consumer example:

```text
cargo run -p castalia-filesystem-core --example snapshot
```

It stores a chunk, file manifest, directory manifest and snapshot in memory,
validates the tree, then lists and reads through the pinned API. The store is a
test/demo adapter, not a durable cache or a mocked remote-availability claim.
