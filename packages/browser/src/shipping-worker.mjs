// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  encryptShipment,
  decryptShipment,
  ShippingError,
} from "./shipping-contract.mjs";
export function installShippingCryptoWorker(scope) {
  const active = new Map();
  let disposed = false;
  const listener = async (event) => {
    const input = event.data;
    if (disposed || !input || !Number.isSafeInteger(input.id) || input.id < 1)
      return;
    if (input.operation === "cancel") {
      const state = active.get(input.id);
      if (state) state.cancelled = true;
      return;
    }
    if (active.has(input.id) || active.size >= 4) {
      scope.postMessage({ id: input.id, ok: false, code: "busy" });
      input.key?.fill?.(0);
      input.bytes?.fill?.(0);
      return;
    }
    const state = { cancelled: false };
    active.set(input.id, state);
    const key = input.key instanceof Uint8Array ? input.key : null;
    let value;
    try {
      if (input.operation === "encrypt")
        value = await encryptShipment(input.bytes, key, input.binding);
      else if (input.operation === "decrypt")
        value = await decryptShipment(
          input.bytes,
          key,
          input.binding,
          input.nonce,
        );
      else throw new ShippingError("invalid");
      if (!disposed && !state.cancelled)
        scope.postMessage({ id: input.id, ok: true, value }, [
          value instanceof Uint8Array ? value.buffer : value.ciphertext.buffer,
        ]);
    } catch (error) {
      if (!disposed && !state.cancelled)
        scope.postMessage({
          id: input.id,
          ok: false,
          code: error?.code ?? "crypto-failed",
        });
    } finally {
      key?.fill(0);
      input.bytes?.fill?.(0);
      const result = value instanceof Uint8Array ? value : value?.ciphertext;
      if (result?.byteLength) result.fill(0);
      active.delete(input.id);
    }
  };
  scope.addEventListener("message", listener);
  return () => {
    disposed = true;
    for (const s of active.values()) s.cancelled = true;
    scope.removeEventListener("message", listener);
  };
}
export function createShippingCryptoClient(worker) {
  let id = 0,
    closed = false;
  const pending = new Map();
  function finish(n, error, value) {
    const p = pending.get(n);
    if (!p) return;
    pending.delete(n);
    clearTimeout(p.timer);
    p.signal?.removeEventListener("abort", p.abort);
    error ? p.reject(error) : p.resolve(value);
  }
  function dispose() {
    if (closed) return;
    closed = true;
    worker.removeEventListener("message", onMessage);
    worker.removeEventListener("error", dispose);
    worker.terminate();
    for (const n of pending.keys())
      finish(n, new ShippingError("worker-unavailable"));
  }
  function onMessage(event) {
    const r = event.data;
    finish(
      r?.id,
      r?.ok ? null : new ShippingError(r?.code ?? "crypto-failed"),
      r?.value,
    );
  }
  worker.addEventListener("error", dispose);
  worker.addEventListener("message", onMessage);
  function call(operation, bytes, key, binding, nonce, signal) {
    if (closed || signal?.aborted) {
      key?.fill?.(0);
      return Promise.reject(
        new ShippingError(closed ? "worker-unavailable" : "cancelled"),
      );
    }
    if (pending.size >= 4) {
      key?.fill?.(0);
      return Promise.reject(new ShippingError("busy"));
    }
    return new Promise((resolve, reject) => {
      const n = ++id,
        timer = setTimeout(dispose, 120000),
        abort = () => {
          try {
            worker.postMessage({ id: n, operation: "cancel" });
          } catch {}
          finish(n, new ShippingError("cancelled"));
        };
      pending.set(n, { resolve, reject, timer, signal, abort });
      signal?.addEventListener("abort", abort, { once: true });
      try {
        worker.postMessage({ id: n, operation, bytes, key, binding, nonce }, [
          bytes.buffer,
          key.buffer,
        ]);
      } catch (e) {
        key?.fill?.(0);
        finish(n, e);
      }
    });
  }
  return {
    encrypt: (bytes, key, binding, signal) =>
      call("encrypt", bytes, key, binding, undefined, signal),
    decrypt: (bytes, key, binding, nonce, signal) =>
      call("decrypt", bytes, key, binding, nonce, signal),
    dispose,
  };
}
