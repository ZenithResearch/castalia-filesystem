// @vitest-environment node
import { describe, expect, it } from "vitest";
import { createBoundedZipOutput } from "../src/bounded-zip-output.mjs";
describe("bounded ZIP output", () => {
  it("returns only a closed, complete ZIP blob within the byte ceiling", async () => {
    const output = createBoundedZipOutput(4);
    const writer = output.stream.getWriter();
    await writer.write(new Uint8Array([1, 2]));
    expect(() => output.blob()).toThrow();
    await writer.write(new Uint8Array([3, 4]));
    await writer.close();
    expect(new Uint8Array(await output.blob().arrayBuffer())).toEqual(
      new Uint8Array([1, 2, 3, 4]),
    );
  });
  it("rejects oversized output without returning a partial blob", async () => {
    const output = createBoundedZipOutput(2);
    const writer = output.stream.getWriter();
    await writer.write(new Uint8Array([1, 2]));
    await expect(writer.write(new Uint8Array([3]))).rejects.toMatchObject({
      code: "archive-limit",
    });
    expect(() => output.blob()).toThrow();
  });
});
