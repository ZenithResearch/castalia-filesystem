# Source provenance

This is a reviewed source export, not an import of private or fork Git history. The core and WASM subtrees originate at `bananawalnut/castalia` commit `c5c0374d8ee00170bfd86c636a708f5c6284bb19`; the filesystem paths were introduced at `5d151d2cafb6123967c985f81b4c82bfed0e18d5` on 2026-10-01. The WASM LICENSE path copied the existing root AGPL document verbatim at that commit; the document ancestry is older. Its Free Software Foundation copyright concerns the license text, not ownership of this program. Preserve original attribution and AGPL-3.0-or-later licensing.

`provenance/extraction.json` records original and extracted file hashes. The extracted subtree alterations are the WASM manifest's repository URL and its current build README. The original README is preserved under `docs/history/`. Core Rust, bridge Rust, fixtures, examples, tests and the WASM dependency lock are byte-for-byte preserved. The native root lock is the reviewed Castalia Web fixture lock at `986808d64795b2f99be41e4badc84c10c6e90cad`. The minimal root workspace replaces unrelated inherited workspace metadata and does not import upstream patches or runtime crates.

The preserved historical bridge README and snapshot document describe their original context, including earlier qualification limits and references to components outside this export. The current README and candidate build document define this repository's scope. Neither historical references nor repository metadata make this an official Dregg artifact.

The portable code has only generic registry dependencies. Its own WASM-to-core path dependency stays inside this repository. No Dregg internal crate, deprecated-fork runtime or sibling checkout is required. Missing supported Dregg APIs remain missing; this extraction does not implement them.

Candidate source identity is read from Git during the build and written only to generated output. It is not embedded as a self-referential constant in tracked source. Public consumers must record both the immutable source commit and independently reviewed package-manifest digest. Historical source retrieval and new candidate publication are distinct provenance facts.

The observed AGPL declarations are retained. This provenance record does not establish additional licensing authority. Missing permission evidence for separately inherited material must be addressed without relabeling it. See [distribution review](AGPL-DISTRIBUTION.md) and [third-party notices](THIRD-PARTY-NOTICES.md).
