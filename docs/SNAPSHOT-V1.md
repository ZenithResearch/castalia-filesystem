# Filesystem snapshot v1 compatibility

The extraction preserves the existing Rust structures and strict decoder. A manifest is `{schema_version:1,node:{kind,body}}`, where kind is directory, file or snapshot. Canonical bytes are compact serde JSON in declared field order, with no trailing newline. Unknown or duplicate fields, alternate whitespace/order, unsafe integers and unsupported versions are rejected.

Every object ID is BLAKE3 of exact stored bytes, encoded as 64 lowercase hexadecimal characters. A snapshot contains `namespace`, `generation`, `previous` and `root`. Namespace is an opaque 32-byte identity, not authority. Generation zero requires a null predecessor; revisions preserve namespace and bind their previous snapshot. The core does not establish ownership or globally coordinate mutable heads.

The golden empty-directory fixture and native/actual-WASM parity tests remain unchanged. No encrypted records, wallet formats, catalog formats, or v1 snapshot fields are migrated. Existing stored bytes remain readable.

The [historical full specification](history/FILESYSTEM-SNAPSHOT-V1.md) is preserved for provenance. References there to storage-client, Sia, Dregg or FUSE integration describe the original repository; those integrations are not supplied or qualified by this export.
