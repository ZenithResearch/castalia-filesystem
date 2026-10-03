// Derived from Castalia Web; source license unresolved. See provenance/browser-extraction.json.
/// <reference lib="webworker" />
import { ShippingError, hexId } from "./shipping-contract.mjs";
import { createShippingStore } from "./shipping-store.mjs";
import {
  captureShipment,
  verifyShipmentArchive,
  restoreShipmentArchive,
} from "./shipping-archive.mjs";
import { RegistrationError } from "./address.mjs";
import { ZipWriter } from "@zip.js/zip.js/lib/zip-core-native.js";
import { createBoundedZipOutput } from "./bounded-zip-output.mjs";
import {
  CatalogError,
  createCatalog,
  parseBinding,
  mutationLockName,
} from "./catalog.mjs";
import { openDatabase } from "./database.mjs";
import { openWorkspaceRoot } from "./workspace-storage.mjs";
import { ZipImportError, importZip } from "./import-zip.mjs";
import { createOperationObjectCache } from "./operation-object-cache.mjs";
import {
  ObjectReadError,
  createOpfsObjectReader,
} from "./opfs-object-reader.mjs";
import {
  ObjectWriteError,
  createOpfsObjectWriter,
} from "./opfs-object-writer.mjs";
import {
  ReclaimError,
  RECLAIM_LIMITS,
  budgetReclaimReads,
  reclaimUnusedObjects,
} from "./reclaim.mjs";
export function createFilesystemRuntime({
  binding,
  wasm,
  storage = globalThis.navigator?.storage,
  locks = globalThis.navigator?.locks,
  indexedDB = globalThis.indexedDB,
  assertMount,
  progress = () => {},
  now = Date.now,
  random = globalThis.crypto,
}) {
  const bound = parseBinding(binding);
  const {
    BrowserFileRevision,
    BrowserSnapshotBuilder,
    PinnedSnapshotReader,
    content_id,
  } = wasm;
  const catalog = createCatalog(bound, { indexedDB });
  const shippingStore = createShippingStore(indexedDB);
  const loadWorkspaceCatalog = catalog.load,
    commitWorkspaceRoot = catalog.commitRoot,
    commitRecoveredCatalog = catalog.recoverInvalid;
  let disposed = false;
  const worker = { postMessage: progress };
  const MIB = 1024 * 1024;
  const MAX_FILE_BYTES = 32 * MIB;
  const MAX_SNAPSHOT_BYTES = 100 * MIB;
  const MAX_EXPORT_BYTES = 128 * MIB;
  let filesystemPromise;

  function filesystem() {
    filesystemPromise ??= (async () => {
      if (bound.kind === "workspace") {
        if (typeof assertMount !== "function")
          throw new CatalogError("unavailable");
        const db = await openDatabase(indexedDB);
        try {
          await assertMount(bound, db);
        } finally {
          db.close();
        }
        try {
          await catalog.load();
        } catch (error) {
          if (!(error instanceof CatalogError) || error.code !== "invalid")
            throw error;
        }
      }
      const root = await openWorkspaceRoot(storage, bound);
      const get = createOpfsObjectReader(root);
      return {
        root,
        reader: new PinnedSnapshotReader(get),
        get,
        put: createOpfsObjectWriter(root, content_id),
      };
    })();
    return filesystemPromise;
  }
  async function withMutationLock(action) {
    if (typeof locks?.request !== "function")
      throw new ObjectWriteError("storage-unavailable");
    return locks.request(mutationLockName(bound), { mode: "exclusive" }, () => {
      if (disposed) throw new ObjectReadError("storage-unavailable");
      return action();
    });
  }
  async function reclaimUnused(fs) {
    const boundedRead = budgetReclaimReads(fs.get);
    let budgetFailure;
    const reader = new PinnedSnapshotReader(async (id, maxBytes) => {
      try {
        return await boundedRead(id, maxBytes);
      } catch (error) {
        if (error instanceof ReclaimError) budgetFailure = error;
        throw error;
      }
    });
    try {
      return await reclaimUnusedObjects(
        fs.root,
        loadWorkspaceCatalog,
        (root) =>
          reader.reachable_ids_bounded(
            root,
            RECLAIM_LIMITS.retainedIds,
            BigInt(RECLAIM_LIMITS.bytesRead),
          ),
        RECLAIM_LIMITS,
        () => shippingStore.pinnedRoots(bound),
      );
    } catch (error) {
      // Rust intentionally maps unknown provider errors; retain this local budget reason.
      throw budgetFailure ?? error;
    } finally {
      reader.free();
    }
  }
  function asNode(value) {
    return JSON.parse(value);
  }
  function asEntries(value) {
    return JSON.parse(value);
  }
  async function streamFile(file, append) {
    if (file.size > MAX_FILE_BYTES) throw new ZipImportError("archive-limit");
    let size = 0;
    const source = file.stream().getReader();
    try {
      for (;;) {
        const { done, value: bytes } = await source.read();
        if (done) break;
        size += bytes.byteLength;
        if (size > MAX_FILE_BYTES) throw new ZipImportError("archive-limit");
        for (let offset = 0; offset < bytes.byteLength; offset += MIB)
          await append(bytes.slice(offset, offset + MIB));
      }
    } finally {
      source.releaseLock();
    }
    if (size !== file.size) throw new ZipImportError("invalid-archive");
  }
  async function exportZip(root, reader) {
    await reader.validate_tree_bounded(root, BigInt(MAX_SNAPSHOT_BYTES));
    const output = createBoundedZipOutput(MAX_EXPORT_BYTES);
    const zip = new ZipWriter(output.stream, {
      useWebWorkers: false,
    });
    async function walk(path) {
      const entries = asEntries(await reader.list(root, path));
      for (const entry of entries) {
        const child = path === "/" ? `/${entry.name}` : `${path}/${entry.name}`;
        const name = child.slice(1);
        const node = asNode(await reader.stat(root, child));
        const modified = node.body.modified_ms ?? 0;
        const lastModDate = new Date(
          Math.max(315532800000, Math.min(modified, 8640000000000000)),
        );
        if (entry.node.kind === "directory") {
          await zip.add(`${name}/`, null, { directory: true, lastModDate });
          await walk(child);
        } else if (entry.node.kind === "file") {
          const size = node.body.size;
          if (
            !Number.isSafeInteger(size) ||
            size === undefined ||
            size < 0 ||
            size > MAX_FILE_BYTES
          )
            throw new ZipImportError("archive-limit");
          let offset = 0;
          const source = new ReadableStream({
            async pull(controller) {
              if (offset >= size) {
                controller.close();
                return;
              }
              const bytes = await reader.read_range(
                root,
                child,
                BigInt(offset),
                Math.min(MIB, size - offset),
              );
              if (bytes.byteLength < 1)
                throw new ObjectReadError("missing-object");
              offset += bytes.byteLength;
              controller.enqueue(bytes);
            },
          });
          await zip.add(name, source, { lastModDate });
        }
      }
    }
    await walk("/");
    await zip.close();
    return output.blob();
  }
  async function execute(request, signal) {
    if (disposed) throw new ObjectReadError("storage-unavailable");
    const fs = await filesystem();
    if (disposed) throw new ObjectReadError("storage-unavailable");
    if (["read", "list", "stat", "export"].includes(request.operation)) {
      const current = await catalog.load();
      if (!current?.revisions.some((item) => item.root === request.root))
        throw new CatalogError("conflict");
    }
    switch (request.operation) {
      case "load": {
        const catalog = await loadWorkspaceCatalog();
        if (catalog) await fs.reader.validate_tree(catalog.head);
        return catalog;
      }
      case "catalog":
        return loadWorkspaceCatalog();
      case "import":
      case "recover":
      case "recover-invalid":
        return withMutationLock(async () => {
          const expectedHead =
            request.operation === "recover" ? request.expectedHead : null;
          if (request.operation === "recover-invalid") {
            try {
              await loadWorkspaceCatalog();
              throw new CatalogError("conflict");
            } catch (error) {
              if (!(error instanceof CatalogError) || error.code !== "invalid")
                throw error;
            }
          } else {
            const current = await loadWorkspaceCatalog();
            if ((current?.head ?? null) !== expectedHead)
              throw new CatalogError("conflict");
          }
          const namespace =
            bound.kind === "workspace"
              ? bound.namespaceId
              : content_id(random.getRandomValues(new Uint8Array(32)));
          const builder = new BrowserSnapshotBuilder(
            namespace,
            BigInt(now()),
            fs.put,
          );
          try {
            await importZip(
              request.file,
              {
                addDirectory: (path, time) => {
                  builder.add_directory(path, BigInt(time));
                },
                beginFile: (path, time, executable) => {
                  builder.begin_file(path, BigInt(time), executable);
                },
                appendChunk: (bytes) => builder.append_chunk(bytes),
                finishFile: () => {
                  builder.finish_file();
                },
              },
              signal,
              (progress) => {
                worker.postMessage({
                  id: request.id,
                  progress,
                });
              },
            );
            if (disposed || signal?.aborted)
              throw new ZipImportError("cancelled");
            const root = await builder.finish();
            if (signal?.aborted) throw new ZipImportError("cancelled");
            await fs.reader.validate_tree_bounded(
              root,
              BigInt(MAX_SNAPSHOT_BYTES),
            );
            if (signal?.aborted) throw new ZipImportError("cancelled");
            return request.operation === "recover-invalid"
              ? await commitRecoveredCatalog(root, now())
              : await commitWorkspaceRoot(expectedHead, root, now());
          } finally {
            builder.free();
          }
        });
      case "list":
        return fs.reader.list(request.root, request.path);
      case "stat":
        return fs.reader.stat(request.root, request.path);
      case "read":
        if (
          !Number.isSafeInteger(request.offset) ||
          request.offset < 0 ||
          !Number.isSafeInteger(request.length) ||
          request.length < 0 ||
          request.length > 4 * MIB
        )
          throw new ObjectReadError("invalid-request");
        return fs.reader.read_range(
          request.root,
          request.path,
          BigInt(request.offset),
          request.length,
        );
      case "revise":
        return withMutationLock(async () => {
          const catalog = await loadWorkspaceCatalog();
          if (catalog?.head !== request.expectedRoot)
            throw new CatalogError("conflict");
          const revision = new BrowserFileRevision(
            request.expectedRoot,
            request.path,
            BigInt(now()),
            false,
            fs.get,
            fs.put,
          );
          try {
            await streamFile(request.file, (bytes) =>
              revision.append_chunk(bytes),
            );
            const root = await revision.finish();
            await fs.reader.validate_tree_bounded(
              root,
              BigInt(MAX_SNAPSHOT_BYTES),
            );
            if (disposed) throw new ObjectReadError("storage-unavailable");
            return await commitWorkspaceRoot(request.expectedRoot, root, now());
          } finally {
            revision.free();
          }
        });
      case "create-shipment":
        return withMutationLock(async () => {
          hexId(request.operationId);
          const current = await loadWorkspaceCatalog();
          if (!current?.revisions.some((item) => item.root === request.root))
            throw new CatalogError("conflict");
          await shippingStore.pin(bound, request.operationId, request.root);
          try {
            const blob = await captureShipment(
              fs,
              wasm,
              request.root,
              request.path,
            );
            if (disposed || signal?.aborted)
              throw new ShippingError("cancelled");
            return blob;
          } catch (error) {
            await shippingStore.release(bound, request.operationId);
            throw error;
          }
        });
      case "release-shipment":
        return withMutationLock(() =>
          shippingStore.release(bound, request.operationId),
        );
      case "verify-shipment": {
        const { header } = await verifyShipmentArchive(request.blob, wasm);
        if (disposed || signal?.aborted) throw new ShippingError("cancelled");
        return {
          root: header.sourceRoot,
          path: header.sourcePath,
          kind: header.kind,
        };
      }
      case "restore-shipment":
        return withMutationLock(async () => {
          const current = await loadWorkspaceCatalog();
          if ((current?.head ?? null) !== request.expectedHead)
            throw new CatalogError("conflict");
          const root = await restoreShipmentArchive(
            request.blob,
            wasm,
            fs,
            bound,
            now(),
          );
          if (disposed || signal?.aborted) throw new ShippingError("cancelled");
          await fs.reader.validate_tree_bounded(
            root,
            BigInt(MAX_SNAPSHOT_BYTES),
          );
          if (disposed || signal?.aborted) throw new ShippingError("cancelled");
          return commitWorkspaceRoot(request.expectedHead, root, now());
        });
      case "reclaim":
        return withMutationLock(() => reclaimUnused(fs));
      case "export": {
        const reader = new PinnedSnapshotReader(
          createOperationObjectCache(fs.get, 8 * MIB),
        );
        try {
          return await exportZip(request.root, reader);
        } finally {
          reader.free();
        }
      }
      default:
        throw new ObjectReadError("invalid-request");
    }
  }
  const operations = new Set();
  function dispatch(request, signal) {
    const pending = execute(request, signal);
    operations.add(pending);
    void pending.finally(() => operations.delete(pending)).catch(() => {});
    return pending;
  }
  return Object.freeze({
    binding: bound,
    execute: dispatch,
    async dispose() {
      disposed = true;
      await Promise.allSettled([...operations]);
      if (filesystemPromise) {
        const fs = await filesystemPromise.catch(() => null);
        fs?.reader.free();
      }
    },
  });
}

export function filesystemErrorCode(error) {
  if (
    error instanceof ShippingError ||
    error instanceof RegistrationError ||
    error instanceof CatalogError ||
    error instanceof ZipImportError ||
    error instanceof ObjectReadError ||
    error instanceof ObjectWriteError ||
    error instanceof ReclaimError
  )
    return error.code;
  const message = String(error).toLowerCase();
  if (message.includes("integrity") || message.includes("oversized-object"))
    return "integrity";
  if (message.includes("quota")) return "quota";
  if (message.includes("unavailable")) return "storage-unavailable";
  if (message.includes("notfound") || message.includes("object callback"))
    return "missing-object";
  if (message.includes("limit")) return "archive-limit";
  return "filesystem-error";
}
