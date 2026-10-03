import { describe, expect, it } from "vitest";
import { createOperationObjectCache } from "../src/operation-object-cache.mjs";
describe("operation-scoped object cache", () => {
  it("reuses bounded reads and still enforces each requested byte cap", async () => {
    let reads = 0;
    const get = () => {
      reads += 1;
      return Promise.resolve(new Uint8Array([1, 2]));
    };
    const cached = createOperationObjectCache(get, 4);
    expect(await cached("a", 2)).toEqual(new Uint8Array([1, 2]));
    expect(await cached("a", 2)).toEqual(new Uint8Array([1, 2]));
    expect(reads).toBe(1);
    await expect(cached("a", 1)).rejects.toMatchObject({
      code: "oversized-object",
    });
    expect(reads).toBe(1);
  });
  it("evicts least-recently-used entries when the operation budget fills", async () => {
    const reads = [];
    const cached = createOperationObjectCache((id) => {
      reads.push(id);
      return Promise.resolve(new Uint8Array([id.charCodeAt(0), 0]));
    }, 4);
    await cached("a", 2);
    await cached("b", 2);
    await cached("a", 2);
    await cached("c", 2);
    await cached("b", 2);
    expect(reads).toEqual(["a", "b", "c", "b"]);
  });
});
