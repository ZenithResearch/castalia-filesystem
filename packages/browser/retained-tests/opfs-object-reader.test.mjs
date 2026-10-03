import { describe, expect, it, vi } from "vitest";
import { createOpfsObjectReader } from "../src/opfs-object-reader.mjs";
const id = "a".repeat(64);
function fixture(size, data = new Uint8Array(size)) {
  const arrayBuffer = vi.fn(() => Promise.resolve(data.buffer));
  const getFile = vi.fn(() => Promise.resolve({ size, arrayBuffer }));
  const getFileHandle = vi.fn(() => Promise.resolve({ getFile }));
  const prefix = { getFileHandle };
  const objects = {
    getDirectoryHandle: vi.fn(() => Promise.resolve(prefix)),
  };
  const root = {
    getDirectoryHandle: vi.fn(() => Promise.resolve(objects)),
  };
  return { root, arrayBuffer, getFileHandle, objects };
}
describe("OPFS object reader", () => {
  it("reads only a hash-named object under its prefix", async () => {
    const data = new Uint8Array([1, 2, 3]);
    const source = fixture(data.length, data);
    await expect(createOpfsObjectReader(source.root)(id, 3)).resolves.toEqual(
      data,
    );
    expect(source.objects.getDirectoryHandle).toHaveBeenCalledWith("aa");
    expect(source.getFileHandle).toHaveBeenCalledWith(id);
  });
  it("rejects invalid requests before opening storage", async () => {
    const source = fixture(1);
    const read = createOpfsObjectReader(source.root);
    await expect(read("../bad", 1)).rejects.toMatchObject({
      code: "invalid-request",
    });
    await expect(read(id, 4 * 1024 * 1024 + 1)).rejects.toMatchObject({
      code: "invalid-request",
    });
    expect(source.arrayBuffer).not.toHaveBeenCalled();
  });
  it("rejects oversize before allocating file bytes", async () => {
    const source = fixture(4);
    await expect(
      createOpfsObjectReader(source.root)(id, 3),
    ).rejects.toMatchObject({ code: "oversized-object" });
    expect(source.arrayBuffer).not.toHaveBeenCalled();
  });
  it("rejects a race where bytes exceed the reported size", async () => {
    const source = fixture(2, new Uint8Array([1, 2, 3]));
    await expect(
      createOpfsObjectReader(source.root)(id, 2),
    ).rejects.toMatchObject({ code: "oversized-object" });
  });
  it("reports missing objects distinctly", async () => {
    const source = fixture(1);
    source.getFileHandle.mockRejectedValueOnce(
      new DOMException("missing", "NotFoundError"),
    );
    await expect(
      createOpfsObjectReader(source.root)(id, 1),
    ).rejects.toMatchObject({ code: "missing-object" });
  });
});
