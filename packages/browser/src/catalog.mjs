// SPDX-License-Identifier: AGPL-3.0-or-later
import { openDatabase, atomic, workspaceKey, addressKey } from "./database.mjs";
import { exact, entityKey, hex32, parseAddress } from "./address.mjs";
import { CatalogError, parseWorkspaceCatalog } from "./catalog-format.mjs";
export { CatalogError, parseWorkspaceCatalog } from "./catalog-format.mjs";
const ID = /^[0-9a-f]{64}$/u;
export function parseBinding(raw) {
  if (raw?.kind === "legacy") {
    exact(raw, ["kind"]);
    return Object.freeze({ kind: "legacy" });
  }
  exact(raw, [
    "kind",
    "namespaceId",
    "workspaceId",
    "entityRef",
    "registrationGenesisDigest",
  ]);
  if (raw.kind !== "workspace") throw new CatalogError("invalid");
  const address = parseAddress({
    namespaceId: raw.namespaceId,
    workspaceId: raw.workspaceId,
  });
  entityKey(raw.entityRef);
  hex32(raw.registrationGenesisDigest);
  return Object.freeze({
    ...address,
    kind: "workspace",
    entityRef: raw.entityRef,
    registrationGenesisDigest: raw.registrationGenesisDigest,
  });
}
export function bindingKey(value) {
  const b = parseBinding(value);
  return b.kind === "legacy"
    ? "legacy"
    : `${addressKey({ namespaceId: b.namespaceId, workspaceId: b.workspaceId })}:${b.entityRef}:${b.registrationGenesisDigest}`;
}
export function mutationLockName(value) {
  const b = parseBinding(value);
  return b.kind === "legacy"
    ? "castalia-browser-filesystem-mutation-v2"
    : `castalia-filesystem-workspace-v1:${b.namespaceId}:${b.workspaceId}`;
}
function boundCatalog(raw, b) {
  if (b.kind === "legacy") return raw;
  if (raw === undefined) throw new CatalogError("conflict");
  exact(raw, [
    "schema",
    "address",
    "entityRef",
    "registrationGenesisDigest",
    "catalog",
  ]);
  const address = parseAddress(raw.address);
  if (raw.schema !== "castalia.filesystem-workspace.v1")
    throw new CatalogError("unsupported-version");
  if (
    address.namespaceId !== b.namespaceId ||
    address.workspaceId !== b.workspaceId ||
    raw.entityRef !== b.entityRef ||
    raw.registrationGenesisDigest !== b.registrationGenesisDigest
  )
    throw new CatalogError("conflict");
  return raw.catalog;
}
export function createCatalog(
  binding,
  { indexedDB = globalThis.indexedDB } = {},
) {
  const b = parseBinding(binding),
    key =
      b.kind === "legacy"
        ? "workspace"
        : workspaceKey({
            namespaceId: b.namespaceId,
            workspaceId: b.workspaceId,
          });
  async function run(mode, action) {
    const db = await openDatabase(indexedDB);
    try {
      return await atomic(db, mode, (store, resolve, abort) => {
        const request = store.get(key);
        request.addEventListener(
          "success",
          () => {
            try {
              action(
                request.result,
                boundCatalog(request.result, b),
                store,
                resolve,
              );
            } catch (error) {
              abort(error);
            }
          },
          { once: true },
        );
      });
    } finally {
      db.close();
    }
  }
  function write(raw, catalog, store, resolve) {
    store.put(b.kind === "legacy" ? catalog : { ...raw, catalog }, key);
    resolve(catalog);
  }
  function next(nextRoot, committedMs) {
    if (
      typeof nextRoot !== "string" ||
      !ID.test(nextRoot) ||
      !Number.isSafeInteger(committedMs) ||
      committedMs < 0
    )
      throw new CatalogError("invalid");
    return { root: nextRoot, committedMs };
  }
  return Object.freeze({
    binding: b,
    load: () =>
      run("readonly", (_raw, value, _store, resolve) =>
        resolve(value === undefined ? null : parseWorkspaceCatalog(value)),
      ),
    commitRoot: async (expectedHead, nextRoot, committedMs) => {
      const revision = next(nextRoot, committedMs);
      if (
        expectedHead !== null &&
        (typeof expectedHead !== "string" || !ID.test(expectedHead))
      )
        throw new CatalogError("invalid");
      return run("readwrite", (raw, value, store, resolve) => {
        const current =
          value === undefined ? null : parseWorkspaceCatalog(value);
        if ((current?.head ?? null) !== expectedHead)
          throw new CatalogError("conflict");
        const revisions = current?.revisions ?? [];
        if (revisions.length >= 1024) throw new CatalogError("limit");
        if (revisions.some((item) => item.root === nextRoot))
          throw new CatalogError("conflict");
        write(
          raw,
          {
            schema: "castalia.browser-filesystem-catalog.v1",
            head: nextRoot,
            revisions: [...revisions, revision],
          },
          store,
          resolve,
        );
      });
    },
    recoverInvalid: async (nextRoot, committedMs) => {
      const revision = next(nextRoot, committedMs);
      return run("readwrite", (raw, value, store, resolve) => {
        if (value === undefined) throw new CatalogError("conflict");
        try {
          parseWorkspaceCatalog(value);
          throw new CatalogError("conflict");
        } catch (error) {
          if (!(error instanceof CatalogError) || error.code !== "invalid")
            throw error;
        }
        write(
          raw,
          {
            schema: "castalia.browser-filesystem-catalog.v1",
            head: nextRoot,
            revisions: [revision],
          },
          store,
          resolve,
        );
      });
    },
  });
}
export const createLegacyCatalog = (options) =>
  createCatalog({ kind: "legacy" }, options);
export const createWorkspaceCatalog = (binding, options) =>
  createCatalog({ kind: "workspace", ...binding }, options);
