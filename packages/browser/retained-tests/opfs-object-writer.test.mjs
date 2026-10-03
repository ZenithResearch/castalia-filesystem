import { describe, expect, it, vi } from "vitest";
import { createOpfsObjectWriter } from "../src/opfs-object-writer.mjs";
const id = "a".repeat(64);
function fixture(initial = new Uint8Array()) {
  let stored = initial;
  const close = vi.fn(() => Promise.resolve());
  const write = vi.fn((bytes) => {
    stored = bytes;
    return Promise.resolve();
  });
  const handle = {
    getFile: vi.fn(() =>
      Promise.resolve({
        size: stored.byteLength,
        arrayBuffer: () => Promise.resolve(stored.buffer),
      }),
    ),
    createWritable: vi.fn(() => Promise.resolve({ write, close })),
  };
  const prefix = { getFileHandle: vi.fn(() => Promise.resolve(handle)) };
  const objects = {
    getDirectoryHandle: vi.fn(() => Promise.resolve(prefix)),
  };
  const root = {
    getDirectoryHandle: vi.fn(() => Promise.resolve(objects)),
  };
  return { root, handle, write, close, prefix, objects };
}
describe("OPFS immutable object writer", () => {
  it("closes and reopens staged bytes before acknowledging an ID", async () => {
    const source = fixture();
    const bytes = new Uint8Array([1, 2, 3]);
    await expect(
      createOpfsObjectWriter(source.root, () => id)(bytes),
    ).resolves.toBe(id);
    expect(source.write).toHaveBeenCalledOnce();
    expect(source.close).toHaveBeenCalledOnce();
    expect(source.handle.getFile).toHaveBeenCalledTimes(2);
    expect(source.objects.getDirectoryHandle).toHaveBeenCalledWith("aa", {
      create: true,
    });
  });
  it("does not replace a corrupt existing hash-named object", async () => {
    const source = fixture(new Uint8Array([9]));
    await expect(
      createOpfsObjectWriter(source.root, () => id)(new Uint8Array([1])),
    ).rejects.toMatchObject({ code: "integrity" });
    expect(source.write).not.toHaveBeenCalled();
  });
  it("enforces object size before opening OPFS", async () => {
    const source = fixture();
    await expect(
      createOpfsObjectWriter(
        source.root,
        () => id,
      )(new Uint8Array(1024 * 1024 + 1)),
    ).rejects.toMatchObject({ code: "invalid-request" });
    expect(source.objects.getDirectoryHandle).not.toHaveBeenCalled();
  });
  it("reports quota failure without returning an ID", async () => {
    const source = fixture();
    source.handle.createWritable.mockRejectedValueOnce(
      new DOMException("full", "QuotaExceededError"),
    );
    await expect(
      createOpfsObjectWriter(source.root, () => id)(new Uint8Array([1])),
    ).rejects.toMatchObject({ code: "quota" });
  });
  it("does not acknowledge an object when the write fails", async () => {
    const source = fixture();
    source.write.mockRejectedValueOnce(new Error("write failed"));
    await expect(
      createOpfsObjectWriter(source.root, () => id)(new Uint8Array([1])),
    ).rejects.toMatchObject({ code: "storage-unavailable" });
    expect(source.close).not.toHaveBeenCalled();
  });
  it("does not acknowledge an object when close fails", async () => {
    const source = fixture();
    source.close.mockRejectedValueOnce(new Error("close failed"));
    await expect(
      createOpfsObjectWriter(source.root, () => id)(new Uint8Array([1])),
    ).rejects.toMatchObject({ code: "storage-unavailable" });
  });
});
