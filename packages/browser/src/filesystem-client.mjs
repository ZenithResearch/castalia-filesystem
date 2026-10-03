// Derived from Castalia Web; source license unresolved. See provenance/browser-extraction.json.
import { parseBinding } from "./catalog.mjs";
export class FilesystemClientError extends Error {
  code;
  constructor(code) {
    super(code);
    this.code = code;
    this.name = "FilesystemClientError";
  }
}
export function createFilesystemClient(worker, binding) {
  const bound = parseBinding(binding);
  const HEARTBEAT_INTERVAL_MS = 2_000;
  const WORKER_UNRESPONSIVE_MS = 12_000;
  let nextId = 0;
  let activeImportId = null;
  let lastWorkerMessage = performance.now();
  let unavailable = false;
  const pending = new Map();
  const onMessage = (event) => {
    lastWorkerMessage = performance.now();
    const response = event.data;
    if (response.id === 0) return;
    const handler = pending.get(response.id);
    if (!handler) return;
    if ("progress" in response) {
      handler.onProgress?.(response.progress);
      return;
    }
    pending.delete(response.id);
    if (response.ok) handler.resolve(response.value);
    else handler.reject(new FilesystemClientError(response.code));
  };
  const onError = () => {
    if (unavailable) return;
    unavailable = true;
    clearInterval(heartbeat);
    worker.terminate();
    for (const handler of pending.values())
      handler.reject(new FilesystemClientError("worker-unavailable"));
    pending.clear();
  };
  worker.addEventListener("message", onMessage);
  worker.addEventListener("error", onError);
  const heartbeat = setInterval(() => {
    if (pending.size === 0 || unavailable) return;
    if (performance.now() - lastWorkerMessage > WORKER_UNRESPONSIVE_MS) {
      onError();
      return;
    }
    try {
      worker.postMessage({ id: 0, operation: "ping", binding: bound });
    } catch {
      onError();
    }
  }, HEARTBEAT_INTERVAL_MS);
  function call(request, onProgress) {
    if (unavailable)
      return Promise.reject(new FilesystemClientError("worker-unavailable"));
    const id = ++nextId;
    if (pending.size === 0) lastWorkerMessage = performance.now();
    if (
      request.operation === "import" ||
      request.operation === "recover" ||
      request.operation === "recover-invalid"
    )
      activeImportId = id;
    const promise = new Promise((resolve, reject) => {
      pending.set(id, {
        resolve(value) {
          resolve(value);
        },
        reject,
        ...(onProgress ? { onProgress } : {}),
      });
      try {
        worker.postMessage({ ...request, id, binding: bound });
      } catch {
        pending.delete(id);
        reject(new FilesystemClientError("worker-unavailable"));
      }
    });
    return promise.finally(() => {
      if (activeImportId === id) activeImportId = null;
    });
  }
  const ready = call({ operation: "bind" });
  // Mark rejection handled even if a consumer closes before awaiting ready.
  void ready.catch(() => {});
  const send = (request, onProgress) =>
    ready.then(() => call(request, onProgress));
  return Object.freeze({
    binding: bound,
    ready,
    load: () => send({ operation: "load" }),
    catalog: () => send({ operation: "catalog" }),
    import: (file, onProgress) =>
      send({ operation: "import", file }, onProgress),
    recover: (expectedHead, file, onProgress) =>
      send({ operation: "recover", expectedHead, file }, onProgress),
    recoverInvalid: (file, onProgress) =>
      send({ operation: "recover-invalid", file }, onProgress),
    reclaim: () => send({ operation: "reclaim" }),
    cancelImport() {
      if (activeImportId !== null)
        worker.postMessage({
          id: 0,
          operation: "cancel-import",
          binding: bound,
          targetId: activeImportId,
        });
    },
    async list(root, path) {
      return JSON.parse(await send({ operation: "list", root, path }));
    },
    async stat(root, path) {
      return JSON.parse(await send({ operation: "stat", root, path }));
    },
    read: (root, path, offset, length) =>
      send({ operation: "read", root, path, offset, length }),
    revise: (expectedRoot, path, file) =>
      send({ operation: "revise", expectedRoot, path, file }),
    export: (root) => send({ operation: "export", root }),
    destroy() {
      worker.removeEventListener("message", onMessage);
      worker.removeEventListener("error", onError);
      onError();
    },
  });
}
