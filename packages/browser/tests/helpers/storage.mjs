import { IDBFactory } from "fake-indexeddb";
import { openDatabase, atomic, workspaceKey } from "../../src/database.mjs";
export const id = (digit) => digit.repeat(64);
export const binding = (namespace = "a", workspace = "b") => ({
  kind: "workspace",
  namespaceId: id(namespace),
  workspaceId: id(workspace),
  entityRef: `urn:castalia:entity:${id("e")}`,
  registrationGenesisDigest: id("f"),
});
export const catalog = (root = id("1")) => ({
  schema: "castalia.browser-filesystem-catalog.v1",
  head: root,
  revisions: [{ root, committedMs: 1 }],
});
export async function putRow(factory, b, value) {
  const db = await openDatabase(factory);
  try {
    await atomic(db, "readwrite", (store, resolve) => {
      store.put(
        b.kind === "legacy"
          ? value
          : {
              schema: "castalia.filesystem-workspace.v1",
              address: {
                namespaceId: b.namespaceId,
                workspaceId: b.workspaceId,
              },
              entityRef: b.entityRef,
              registrationGenesisDigest: b.registrationGenesisDigest,
              catalog: value,
            },
        b.kind === "legacy"
          ? "workspace"
          : workspaceKey({
              namespaceId: b.namespaceId,
              workspaceId: b.workspaceId,
            }),
      );
      resolve();
    });
  } finally {
    db.close();
  }
}
export class MemoryDirectory {
  kind = "directory";
  children = new Map();
  constructor(name = "", faults = {}) {
    this.name = name;
    this.faults = faults;
  }
  async getDirectoryHandle(name, { create = false } = {}) {
    let child = this.children.get(name);
    if (!child && create) {
      child = new MemoryDirectory(name, this.faults);
      this.children.set(name, child);
    }
    if (!child) throw new DOMException("missing", "NotFoundError");
    if (child.kind !== "directory")
      throw new DOMException("type", "TypeMismatchError");
    return child;
  }
  async getFileHandle(name, { create = false } = {}) {
    let child = this.children.get(name);
    if (!child && create) {
      child = new MemoryFile(name, this.faults);
      this.children.set(name, child);
    }
    if (!child) throw new DOMException("missing", "NotFoundError");
    if (child.kind !== "file")
      throw new DOMException("type", "TypeMismatchError");
    return child;
  }
  async *values() {
    yield* this.children.values();
  }
  async removeEntry(name) {
    if (!this.children.delete(name))
      throw new DOMException("missing", "NotFoundError");
  }
}
class MemoryFile {
  kind = "file";
  bytes = new Uint8Array();
  constructor(name, faults) {
    this.name = name;
    this.faults = faults;
  }
  async getFile() {
    const value = new Blob([this.bytes]);
    return value;
  }
  async createWritable() {
    let staged;
    return {
      write: async (bytes) => {
        if (this.faults.quota)
          throw new DOMException("quota", "QuotaExceededError");
        staged = new Uint8Array(bytes);
      },
      close: async () => {
        if (this.faults.close) throw new DOMException("disk", "UnknownError");
        this.bytes = staged ?? new Uint8Array();
      },
      abort: async () => {},
    };
  }
}
export function environment() {
  const root = new MemoryDirectory();
  const held = new Map(),
    names = [];
  const locks = {
    async request(name, _options, callback) {
      names.push(name);
      const previous = held.get(name) ?? Promise.resolve();
      const result = previous.catch(() => {}).then(callback);
      held.set(name, result);
      try {
        return await result;
      } finally {
        if (held.get(name) === result) held.delete(name);
      }
    },
  };
  return {
    indexedDB: new IDBFactory(),
    storage: { getDirectory: async () => root },
    locks,
    root,
    names,
  };
}
