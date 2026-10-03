import { describe, expect, it, vi } from "vitest";
import {
  budgetReclaimReads,
  reclaimUnusedObjects,
  ReclaimError,
} from "../src/reclaim.mjs";
import { CatalogError } from "../src/catalog.mjs";
import { ObjectReadError } from "../src/opfs-object-reader.mjs";
const retained = "a".repeat(64);
const orphan = "a".repeat(63) + "b";
const catalog = {
  schema: "castalia.browser-filesystem-catalog.v1",
  head: retained,
  revisions: [{ root: retained, committedMs: 1 }],
};
function storage(names) {
  const removeEntry = vi.fn(async () => {});
  const directory = {
    kind: "directory",
    name: "aa",
    removeEntry,
    async *values() {
      await Promise.resolve();
      for (const name of names)
        yield {
          kind: "file",
          name,
          getFile: () => Promise.resolve({ size: 4 }),
        };
    },
  };
  const root = {
    getDirectoryHandle: () =>
      Promise.resolve({
        async *values() {
          await Promise.resolve();
          yield directory;
        },
      }),
  };
  return { root, removeEntry };
}
describe("bounded reclaim planning", () => {
  it("counts retained entries against the scan budget before deleting any orphan", async () => {
    const { root, removeEntry } = storage([orphan, retained]);
    await expect(
      reclaimUnusedObjects(
        root,
        () => Promise.resolve(catalog),
        () => Promise.resolve(JSON.stringify([retained])),
        { retainedIds: 10, scannedEntries: 2 },
      ),
    ).rejects.toThrow(new ReclaimError("reclaim-limit"));
    expect(removeEntry).not.toHaveBeenCalled();
  });
  it("requires unchanged catalog before deleting planned orphans", async () => {
    const { root, removeEntry } = storage([orphan]);
    const load = vi
      .fn()
      .mockResolvedValueOnce(catalog)
      .mockResolvedValueOnce(null);
    await expect(
      reclaimUnusedObjects(root, load, () =>
        Promise.resolve(JSON.stringify([retained])),
      ),
    ).rejects.toThrow(new CatalogError("conflict"));
    expect(removeEntry).not.toHaveBeenCalled();
  });
  it("preserves retained objects and removes only fully planned orphans", async () => {
    const { root, removeEntry } = storage([retained, orphan]);
    await expect(
      reclaimUnusedObjects(
        root,
        () => Promise.resolve(catalog),
        () => Promise.resolve(JSON.stringify([retained])),
      ),
    ).resolves.toEqual({ objects: 1, bytes: 4 });
    expect(removeEntry).toHaveBeenCalledExactlyOnceWith(orphan);
  });
  it("shares read-count budget across repeated references", async () => {
    const get = vi.fn(() => Promise.resolve(new Uint8Array(1)));
    const read = budgetReclaimReads(get, { objectReads: 2, bytesRead: 10 });
    await read(retained, 2);
    await read(retained, 2);
    await expect(read(retained, 2)).rejects.toThrow(
      new ReclaimError("reclaim-limit"),
    );
    expect(get).toHaveBeenCalledTimes(2);
  });
  it("caps each storage read to the remaining aggregate byte budget", async () => {
    const get = vi.fn((_id, maximum) =>
      maximum < 3
        ? Promise.reject(new ObjectReadError("oversized-object"))
        : Promise.resolve(new Uint8Array(3)),
    );
    const read = budgetReclaimReads(get, { objectReads: 10, bytesRead: 5 });
    await read(retained, 4);
    await expect(read(retained, 4)).rejects.toThrow(
      new ReclaimError("reclaim-limit"),
    );
    expect(get).toHaveBeenLastCalledWith(retained, 2);
  });
});
