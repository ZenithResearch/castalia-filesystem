# Castalia Filesystem

Portable immutable filesystem snapshots and a browser Worker WASM bridge for Castalian applications. This repository maintains the reviewed Castalia filesystem code independently of Dregg. It has no Dregg dependency and provides no organisation registry, membership authority, synchronization or remote storage service.

## Current scope

The portable core supplies strict canonical v1 manifests, bounded reads, snapshot construction and copy-on-write revisions. The optional native adapter and CLI remain available for focused testing; kernel FUSE mounts are not qualified. Browser storage adapters and authoritative namespace integration are subsequent work.

Existing manifest bytes, content IDs, namespace fields and fixtures are preserved. Snapshot namespace is an opaque identity, not authorization. See [the wire contract](docs/SNAPSHOT-V1.md), [provenance](docs/SOURCE-PROVENANCE.md) and [candidate builds](docs/CANDIDATE-BUILDS.md).

## Verify

Use Node 24.18.0 and the Rust toolchain in `rust-toolchain.toml`.

```sh
node scripts/verify-extraction.mjs
node --test tests/*.test.mjs
cargo test --workspace --all-targets --locked
cargo clippy --workspace --all-targets --locked -- -D warnings
cargo fmt --all -- --check
```

WASM builds additionally require wasm-pack 0.14.0 and wasm-bindgen-cli 0.2.127. Fetch reviewed dependencies with Cargo `--locked` before the offline build. Candidate packages are generated from a clean committed checkout:

```sh
node scripts/build-package.mjs --out-dir /absolute/new/output-directory
node scripts/verify-package.mjs /absolute/new/output-directory MANIFEST_SHA256 SOURCE_COMMIT
```

Builds and CI do not publish packages, merge branches or deploy applications. A passing library candidate does not qualify its consumers for production.

## License

AGPL-3.0-or-later. See [LICENSE](LICENSE) and the retained historical attribution in [source provenance](docs/SOURCE-PROVENANCE.md). See the [third-party notices](docs/THIRD-PARTY-NOTICES.md) and [distribution review](docs/AGPL-DISTRIBUTION.md); package verification does not establish clearance.
