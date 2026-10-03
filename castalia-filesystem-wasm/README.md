# Castalia filesystem browser bridge

The standalone WASM crate binds the portable v1 snapshot core to browser Workers and Node parity tests. It preserves strict canonical manifests, bounded object callbacks, generation-zero construction, pinned reads and copy-on-write revisions.

Storage callbacks must enforce their byte caps before allocating. The bridge checks lengths and content IDs again. A namespace value is not authority, encryption or synchronization.

Use the repository's `scripts/build-package.mjs` with the pinned tools and locks. It builds both binding targets, runs actual-WASM parity, records the clean source commit and artifact hashes, and marks generated packages private. No registry publication is performed.

Historical source and attribution are recorded in the repository's `PROVENANCE.md`; the original bridge README is retained under `docs/history/`. AGPL-3.0-or-later applies. A verified library candidate does not establish application production qualification.
