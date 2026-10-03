# Shared browser adapter candidate

The browser package is local storage, not a registry service, authorization grant, synchronization service or production-qualified release. Canonical mounts require a reviewed accepted registration. An ordinary unsigned v1 Files snapshot remains a content-addressed local file tree. See [identity mapping](IDENTITY-MAPPING.md) and [registration](BROWSER-REGISTRATION-V1.md).

## Storage compatibility and isolation

The existing IndexedDB database `castalia-browser-filesystem`, version 2, and store `catalog` are retained. The legacy string key `workspace` and origin-root `objects/` directory are unchanged. No automatic migration or recovery rewrites legacy data. Unknown catalog schemas fail closed.

Each registered workspace has compound key `['workspace-v1', namespaceId, workspaceId]`, immutable entity/genesis metadata around its original strict v1 catalog, an independent expected-head CAS, and a Web Lock named `castalia-filesystem-workspace-v1:<namespaceId>:<workspaceId>`. Objects live at `castalia-filesystem-scoped-v1/<namespaceId>/<workspaceId>/objects/`. New roots use the registered namespace ID in the unchanged Rust snapshot builder. Additional workspaces do not create another entity or namespace.

Read, list, stat and ZIP export reject roots absent from the selected catalog's retained revision set. Knowing an object hash does not select another workspace. Cleanup scans only the bound physical workspace and validates all retained roots before deleting anything; read, byte, object and directory-scan budgets remain bounded.

## Consumer setup

Consumers initialize the pinned WASM artifact and supply the exports. No bundler-specific asset import lives in this package.

```js
import { installFilesystemWorker } from "@castalia/filesystem/worker";
import {
  assertAcceptedNamespace,
  loadLocalReviewedIndex,
} from "@castalia/filesystem/registration-store";
installFilesystemWorker(self, {
  wasm: loadWasm(),
  async assertMount(binding, db) {
    return assertAcceptedNamespace(
      db,
      binding,
      await loadLocalReviewedIndex(db),
      { trustPolicy },
    );
  },
});
```

The worker listener is installed before WASM resolves. The first binding is reserved immediately; a second binding or any cross-scope command is rejected. Disposal during initialization cannot create a late runtime. `createFilesystemClient(worker, binding)` sends that binding once and waits for readiness before operations. Destroy the client and create a new worker to switch workspaces.

`stageInitialWorkspace({address, wasm, indexedDB, storage, locks})` rejects an already published workspace and stages a verified empty snapshot under the workspace lock. It does not publish a catalog. Supply its returned catalog to `publishAcceptedRegistration` with the verified registration and reviewed index; entity, controller, namespace, accepted mount and initial catalog publish in the same IndexedDB transaction. A failed registration leaves only unreachable staged objects. `publishWorkspace` adds a child workspace after the current registration is rechecked atomically.

`copyLegacyWorkspace({source, destination, sourceRoot, expectedDestinationHead, confirmed:true})` performs explicit bounded verified ZIP export/import. It never modifies the source. The destination uses its registered namespace and expected-head CAS. This is a file-content copy, not an exact snapshot-history migration: ZIP timestamps and executable metadata follow the existing safe ZIP rules. Failure does not advance the destination head.

## Retained bounds and recovery

The original limits remain: compressed ZIP 50 MiB, expanded snapshot 100 MiB, individual file 32 MiB, 1,000 ZIP entries, 1 MiB chunks, output archive 128 MiB, 4 MiB object reads and 1,024 catalog revisions. Validation rejects traversal, aliases, special files, encryption, invalid CRC and malformed sizes. Quota, worker failure, cancellation, concurrent recovery and unknown schemas retain their previous fail-closed behavior. A trusted ZIP can recover missing-payload snapshots against the expected damaged head, or a still-invalid identified v1 catalog; no unknown-schema recovery is permitted.

## Source and licensing gate

The portable Rust/WASM core retains AGPL-3.0-or-later. Newly authored registration/isolation code is AGPL-3.0-or-later. Browser modules derived from Castalia Web are identified in `provenance/browser-extraction.json`; that source revision has no root license, package license declaration or SPDX headers. Its licensing is unresolved: the root AGPL declaration does not imply permission to relicense inherited source. Consumers remain draft until the source license and their AGPL policy are resolved; do not bypass the policy by vendoring or relabeling.

Runtime ZIP dependency is the supported exact `@zip.js/zip.js` 2.18.2 release, BSD-3-Clause; its license is retained in `licenses/zip-js-BSD-3-Clause.txt`. There is no Dregg or local-path fallback. The locked npm dev dependencies are test/build tooling and are not shipped in the runtime package.

## Verification mapping

The retained Web `import-zip`, `opfs-object-reader`, `files-reclaim`, `bounded-zip-output` `files-catalog`, `operation-object-cache` and `opfs-object-writer` tests are ported with provenance (43 cases). Client progress/cancellation, expected-head recovery, disposal and initialization are covered by new worker/client tests. The Web view/offline-shell boundary tests remain with the consumer; the shared adapter has its own AST egress/import policy check. Additional tests cover independent catalogs/locks/OPFS, concurrent CAS, malformed v1/unknown recovery, transactional registration, immutable metadata, cross-workspace roots, explicit copy, quota faults and actual WASM round trips.

Run `npm ci --ignore-scripts --no-audit --no-fund`, `npm test`, `npm run test:browser-retained`, and `npm run typecheck:browser`. Actual WASM tests require `FILESYSTEM_WASM_PACKAGE` pointing to the complete verified candidate package; CI builds that package before running them. Unit/WASM checks do not imply native-picker, private-backup or production-browser qualification.
