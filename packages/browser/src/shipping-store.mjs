// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  ShippingError,
  hexId,
  SHIPPING_LIMITS,
  parseFilesKeyBinding,
  parseFilesKeyEnvelope,
  assertSameBinding,
  decodeBase64url,
} from "./shipping-contract.mjs";
import { bindingKey, parseBinding, mutationLockName } from "./catalog.mjs";
export const SHIPPING_DATABASE = "castalia-files-shipping-v1";
const STORES = ["operations", "payloads", "pins"];
function operation(value) {
  if (!value || value.schema !== "castalia.files-shipping-operation.v1")
    throw new ShippingError("unsupported-version");
  hexId(value.operationId);
  parseFilesKeyBinding(value.binding);
  parseBinding(value.sourceBinding);
  for (const key of [
    "sourceRoot",
    "registrationGenesisDigest",
    "ciphertextSha256",
    "descriptorDigest",
  ])
    hexId(value[key]);
  if (value.previousRevisionId !== null) hexId(value.previousRevisionId);
  assertSameBinding(
    value.binding,
    parseFilesKeyEnvelope(value.keyEnvelope).binding,
  );
  decodeBase64url(value.nonce, 12);
  if (
    !["Shipping", "Shipped", "Failed"].includes(value.status) ||
    typeof value.detail !== "string" ||
    value.detail.length > 1024 ||
    typeof value.updatedAt !== "string" ||
    !Number.isFinite(Date.parse(value.updatedAt)) ||
    !Number.isSafeInteger(value.byteLength) ||
    value.byteLength < 16 ||
    value.byteLength > SHIPPING_LIMITS.ciphertextBytes ||
    (value.sourcePath !== null &&
      (typeof value.sourcePath !== "string" ||
        !value.sourcePath.startsWith("/") ||
        value.sourcePath.length > 4096)) ||
    JSON.stringify(value).length > 32768
  )
    throw new ShippingError("invalid-journal");
  return value;
}
export function createShippingStore(indexedDB = globalThis.indexedDB) {
  async function open() {
    if (!indexedDB?.open) throw new ShippingError("storage-unavailable");
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(SHIPPING_DATABASE, 1);
      let settled = false;
      const finish = (error, db) => {
        if (settled) {
          db?.close();
          return;
        }
        settled = true;
        clearTimeout(timer);
        if (error) reject(error);
        else resolve(db);
      };
      const timer = setTimeout(
        () => finish(new ShippingError("storage-unavailable")),
        5000,
      );
      request.onupgradeneeded = () => {
        if (settled) {
          request.transaction?.abort();
          request.result.close();
          return;
        }
        for (const name of STORES) request.result.createObjectStore(name);
      };
      request.onsuccess = () => {
        const db = request.result;
        if (settled) {
          db.close();
          return;
        }
        db.onversionchange = () => db.close();
        if (
          [...db.objectStoreNames].sort().join(",") !==
          [...STORES].sort().join(",")
        ) {
          db.close();
          finish(new ShippingError("unsupported-version"));
          return;
        }
        finish(null, db);
      };
      request.onerror = () =>
        finish(
          new ShippingError(
            request.error?.name === "VersionError"
              ? "unsupported-version"
              : "storage-unavailable",
          ),
        );
      request.onblocked = () =>
        finish(new ShippingError("storage-unavailable"));
    });
  }
  async function run(names, mode, action) {
    const db = await open();
    return new Promise((resolve, reject) => {
      let tx, result, error;
      try {
        tx = db.transaction(names, mode);
        action(
          tx,
          (value) => {
            result = value;
          },
          (reason) => {
            error = reason;
            tx.abort();
          },
        );
      } catch (e) {
        db.close();
        reject(e);
        return;
      }
      tx.oncomplete = () => {
        db.close();
        resolve(result);
      };
      tx.onabort = () => {
        db.close();
        reject(
          error ??
            new ShippingError(
              tx.error?.name === "QuotaExceededError"
                ? "quota"
                : "storage-unavailable",
            ),
        );
      };
      tx.onerror = () => {};
    });
  }
  const get = (name, key) =>
    run([name], "readonly", (tx, done) => {
      const r = tx.objectStore(name).get(key);
      r.onsuccess = () => done(r.result);
    });
  const list = (name) =>
    run([name], "readonly", (tx, done) => {
      const r = tx.objectStore(name).getAll();
      r.onsuccess = () => done(r.result);
    });
  return Object.freeze({
    async recoverPreparations(locks) {
      if (typeof locks?.request !== "function")
        throw new ShippingError("storage-unavailable");
      const pins = await list("pins");
      for (const pin of pins) {
        if (pin?.schema !== "castalia.files-shipping-pin.v1")
          throw new ShippingError("unsupported-version");
        hexId(pin.operationId);
        hexId(pin.root);
        parseBinding(pin.binding);
        await locks.request(
          "castalia-files-shipping-operation-v1:" + pin.operationId,
          { mode: "exclusive", ifAvailable: true },
          async (lock) => {
            if (!lock) return;
            const existing = await get("operations", pin.operationId);
            if (existing !== undefined) {
              operation(existing);
              return;
            }
            await locks.request(
              mutationLockName(pin.binding),
              { mode: "exclusive" },
              async () => {
                // The same operation lock covers capture through its atomic first journal write.
                if ((await get("operations", pin.operationId)) !== undefined)
                  return;
                await run(["pins"], "readwrite", (tx, done) => {
                  tx.objectStore("pins").delete(
                    bindingKey(pin.binding) + ":" + pin.operationId,
                  );
                  done();
                });
              },
            );
          },
        );
      }
    },
    async save(record, ciphertext) {
      operation(record);
      if (
        ciphertext !== undefined &&
        (!(ciphertext instanceof Blob) ||
          ciphertext.size > SHIPPING_LIMITS.ciphertextBytes)
      )
        throw new ShippingError("limit");
      return run(
        ["operations", "payloads", "pins"],
        "readwrite",
        (tx, done) => {
          tx.objectStore("operations").put(
            structuredClone(record),
            record.operationId,
          );
          if (ciphertext !== undefined)
            tx.objectStore("payloads").put(ciphertext, record.operationId);
          if (record.status === "Shipped") {
            tx.objectStore("pins").delete(
              bindingKey(record.sourceBinding) + ":" + record.operationId,
            );
            tx.objectStore("payloads").delete(record.operationId);
          }
          done();
        },
      );
    },
    async load(id) {
      hexId(id);
      const record = await get("operations", id);
      return record === undefined ? null : operation(record);
    },
    async ciphertext(id) {
      hexId(id);
      const blob = await get("payloads", id);
      if (
        !(blob instanceof Blob) ||
        blob.size > SHIPPING_LIMITS.ciphertextBytes
      )
        throw new ShippingError("missing-payload");
      return blob;
    },
    async operations(owner, serviceId) {
      return (await list("operations"))
        .map(operation)
        .filter(
          (x) =>
            x.binding.ownerMemberKey === owner &&
            x.binding.serviceId === serviceId,
        );
    },
    async pin(binding, id, root) {
      const key = bindingKey(binding);
      hexId(id);
      hexId(root);
      return run(["pins"], "readwrite", (tx, done) => {
        tx.objectStore("pins").put(
          {
            schema: "castalia.files-shipping-pin.v1",
            binding: parseBinding(binding),
            operationId: id,
            root,
          },
          key + ":" + id,
        );
        done();
      });
    },
    async release(binding, id) {
      const key = bindingKey(binding);
      hexId(id);
      return run(["pins"], "readwrite", (tx, done) => {
        tx.objectStore("pins").delete(key + ":" + id);
        done();
      });
    },
    async pinnedRoots(binding) {
      const key = bindingKey(binding);
      return [
        ...new Set(
          (await list("pins"))
            .map((x) => {
              if (x?.schema !== "castalia.files-shipping-pin.v1")
                throw new ShippingError("unsupported-version");
              hexId(x.operationId);
              hexId(x.root);
              return x;
            })
            .filter((x) => bindingKey(x.binding) === key)
            .map((x) => x.root),
        ),
      ];
    },
    async abandon(id, binding) {
      hexId(id);
      const key = bindingKey(binding);
      return run(STORES, "readwrite", (tx, done) => {
        tx.objectStore("operations").delete(id);
        tx.objectStore("payloads").delete(id);
        tx.objectStore("pins").delete(key + ":" + id);
        done();
      });
    },
  });
}
