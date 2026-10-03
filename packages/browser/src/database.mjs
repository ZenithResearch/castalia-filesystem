// SPDX-License-Identifier: AGPL-3.0-or-later
import { RegistrationError } from "./address.mjs";
export { parseAddress, addressKey, workspaceKey } from "./address.mjs";
export const DATABASE = "castalia-browser-filesystem";
export const DATABASE_VERSION = 2;
export const WORKSPACES = "catalog";
/** Preserve the legacy database/store/version; new rows use compound keys. */
export function openDatabase(factory = globalThis.indexedDB) {
  if (!factory) return Promise.reject(new RegistrationError("unavailable"));
  return new Promise((resolve, reject) => {
    const request = factory.open(DATABASE, DATABASE_VERSION);
    let settled = false;
    const fail = () => {
      settled = true;
      reject(new RegistrationError("unavailable"));
    };
    request.addEventListener("upgradeneeded", () => {
      if (settled) {
        request.transaction?.abort();
        return;
      }
      if (!request.result.objectStoreNames.contains(WORKSPACES))
        request.result.createObjectStore(WORKSPACES);
    });
    request.addEventListener(
      "success",
      () => {
        const db = request.result;
        db.addEventListener("versionchange", () => db.close());
        if (settled) {
          db.close();
          return;
        }
        settled = true;
        resolve(db);
      },
      { once: true },
    );
    request.addEventListener("blocked", fail, { once: true });
    request.addEventListener("error", fail, { once: true });
  });
}
/** A synchronous callback only: crypto and other awaits must precede this transaction. */
export function atomic(db, mode, callback) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(WORKSPACES, mode);
    let result, failure;
    const abort = (error) => {
      failure = error;
      try {
        tx.abort();
      } catch {
        /* already aborted */
      }
    };
    tx.addEventListener("complete", () => resolve(result), { once: true });
    tx.addEventListener(
      "abort",
      () => reject(failure ?? new RegistrationError("unavailable")),
      { once: true },
    );
    tx.addEventListener("error", () => {
      failure ??= new RegistrationError("unavailable");
    });
    try {
      callback(
        tx.objectStore(WORKSPACES),
        (value) => {
          result = value;
        },
        abort,
      );
    } catch (error) {
      abort(error);
    }
  });
}
