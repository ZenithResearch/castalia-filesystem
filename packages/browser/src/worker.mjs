// SPDX-License-Identifier: AGPL-3.0-or-later
import { createFilesystemRuntime, filesystemErrorCode } from "./runtime.mjs";
import { parseBinding, bindingKey } from "./catalog.mjs";
/** A worker accepts one binding for its entire lifetime; changing scope requires a new worker. */
export function installFilesystemWorker(port, options) {
  let runtime,
    boundKey,
    disposed = false;
  const active = new Map();
  const post = (value, transfer) => {
    if (!disposed) port.postMessage(value, transfer ?? []);
  };
  const listener = (event) => {
    const request = event.data;
    if (disposed || !request || typeof request !== "object") return;
    try {
      if (request.operation === "bind") {
        if (boundKey !== undefined)
          throw new Error("invalid binding: worker already bound");
        const binding = parseBinding(request.binding);
        boundKey = bindingKey(binding);
        Promise.resolve()
          .then(() =>
            typeof options.wasm === "function" ? options.wasm() : options.wasm,
          )
          .then((wasm) => {
            if (disposed) return;
            runtime = createFilesystemRuntime({
              ...options,
              wasm,
              binding,
              progress: post,
            });
            post({ id: request.id, ok: true, value: null });
          })
          .catch((error) =>
            post({
              id: request.id,
              ok: false,
              code: filesystemErrorCode(error),
            }),
          );
        return;
      }
      if (!runtime || bindingKey(request.binding) !== boundKey)
        throw new Error("invalid binding");
      if (request.operation === "ping") {
        post({ id: 0, ok: true, value: null });
        return;
      }
      if (request.operation === "cancel-import") {
        active.get(request.targetId)?.abort();
        return;
      }
      if (
        !Number.isSafeInteger(request.id) ||
        request.id < 1 ||
        active.has(request.id)
      )
        throw new Error("invalid request");
      const controller = new AbortController();
      active.set(request.id, controller);
      void runtime
        .execute(request, controller.signal)
        .then(
          (value) => {
            const response = { id: request.id, ok: true, value };
            post(
              response,
              request.operation === "read" && value instanceof Uint8Array
                ? [value.buffer]
                : [],
            );
          },
          (error) =>
            post({
              id: request.id,
              ok: false,
              code: filesystemErrorCode(error),
            }),
        )
        .finally(() => active.delete(request.id));
    } catch (error) {
      post({ id: request.id, ok: false, code: "invalid-request" });
    }
  };
  port.addEventListener("message", listener);
  return async () => {
    disposed = true;
    port.removeEventListener("message", listener);
    for (const c of active.values()) c.abort();
    await runtime?.dispose();
  };
}
