// SPDX-License-Identifier: AGPL-3.0-or-later
import { openDatabase, atomic, workspaceKey } from "./database.mjs";
import { CatalogError } from "./catalog-format.mjs";
import { parseAddress } from "./address.mjs";
import { parseBinding, mutationLockName } from "./catalog.mjs";
import {
  ObjectReadError,
  createOpfsObjectReader,
} from "./opfs-object-reader.mjs";
import {
  ObjectWriteError,
  createOpfsObjectWriter,
} from "./opfs-object-writer.mjs";
export async function openWorkspaceRoot(storage, binding) {
  const b = parseBinding(binding);
  if (typeof storage?.getDirectory !== "function")
    throw new ObjectReadError("storage-unavailable");
  try {
    const root = await storage.getDirectory();
    if (b.kind === "legacy") return root;
    const scoped = await root.getDirectoryHandle(
      "castalia-filesystem-scoped-v1",
      { create: true },
    );
    const namespace = await scoped.getDirectoryHandle(b.namespaceId, {
      create: true,
    });
    return await namespace.getDirectoryHandle(b.workspaceId, { create: true });
  } catch (error) {
    if (error?.name === "QuotaExceededError")
      throw new ObjectWriteError("quota");
    throw new ObjectReadError("storage-unavailable");
  }
}
/** Stages unreachable objects only. Registration publishes the returned catalog atomically. */
export async function stageInitialWorkspace({
  address,
  wasm,
  storage = globalThis.navigator?.storage,
  locks = globalThis.navigator?.locks,
  indexedDB = globalThis.indexedDB,
  now = Date.now,
}) {
  const a = parseAddress(address);
  if (typeof locks?.request !== "function")
    throw new ObjectWriteError("storage-unavailable");
  // The staging path is a location, not an assertion that an entity is registered.
  const location = {
    kind: "workspace",
    ...a,
    entityRef: `urn:castalia:entity:${"0".repeat(64)}`,
    registrationGenesisDigest: "0".repeat(64),
  };
  return locks.request(
    mutationLockName(location),
    { mode: "exclusive" },
    async () => {
      const db = await openDatabase(indexedDB);
      try {
        await atomic(db, "readonly", (store, resolve, abort) => {
          const get = store.get(workspaceKey(a));
          get.addEventListener(
            "success",
            () => {
              if (get.result !== undefined) abort(new CatalogError("conflict"));
              else resolve();
            },
            { once: true },
          );
        });
      } finally {
        db.close();
      }
      const root = await openWorkspaceRoot(storage, location);
      const put = createOpfsObjectWriter(root, wasm.content_id);
      const builder = new wasm.BrowserSnapshotBuilder(
        a.namespaceId,
        BigInt(now()),
        put,
      );
      const reader = new wasm.PinnedSnapshotReader(
        createOpfsObjectReader(root),
      );
      try {
        const head = await builder.finish();
        await reader.validate_tree_bounded(head, 100n * 1024n * 1024n);
        return {
          schema: "castalia.browser-filesystem-catalog.v1",
          head,
          revisions: [{ root: head, committedMs: now() }],
        };
      } finally {
        reader.free();
        builder.free();
      }
    },
  );
}
