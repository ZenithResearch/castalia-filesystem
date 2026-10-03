// @vitest-environment node
import { File as NodeFile } from "node:buffer";
import { BlobWriter, TextReader, ZipWriter } from "@zip.js/zip.js";
import { describe, expect, it } from "vitest";
import { importZip, validateZipPath } from "../src/import-zip.mjs";
async function archive(entries) {
  const writer = new ZipWriter(new BlobWriter("application/zip"));
  for (const entry of entries)
    await writer.add(
      entry.name,
      entry.data === undefined ? null : new TextReader(entry.data),
      { directory: entry.name.endsWith("/") },
    );
  return new NodeFile(
    [new Uint8Array(await (await writer.close()).arrayBuffer())],
    "test.zip",
    {
      type: "application/zip",
    },
  );
}
function sink() {
  const calls = [];
  const bytes = [];
  const target = {
    addDirectory(path) {
      calls.push(`directory:${path}`);
    },
    beginFile(path) {
      calls.push(`begin:${path}`);
    },
    appendChunk(chunk) {
      bytes.push(chunk);
      return Promise.resolve();
    },
    finishFile() {
      calls.push("finish");
    },
  };
  return { target, calls, bytes };
}
describe("bounded ZIP import", () => {
  it("streams files and directories into a portable snapshot sink", async () => {
    const input = await archive([
      { name: "notes/a.txt", data: "hello" },
      { name: "notes/" },
      { name: "empty.txt", data: "" },
    ]);
    const output = sink();
    await importZip(input, output.target);
    expect(output.calls).toEqual([
      "begin:/empty.txt",
      "finish",
      "directory:/notes",
      "begin:/notes/a.txt",
      "finish",
    ]);
    expect(new TextDecoder().decode(output.bytes[0])).toBe("hello");
  });
  it.each(["../escape.txt", "/absolute.txt", "a\\b.txt", "a/./b.txt"])(
    "rejects unsafe path %s",
    (name) => {
      expect(() => validateZipPath(name, false)).toThrow(
        expect.objectContaining({
          code: "unsafe-path",
        }),
      );
    },
  );
  it("rejects casefold collisions across implicit parents before staging", async () => {
    const input = await archive([
      { name: "Notes/a.txt", data: "a" },
      { name: "notes/b.txt", data: "b" },
    ]);
    const output = sink();
    await expect(importZip(input, output.target)).rejects.toMatchObject({
      code: "unsafe-path",
    });
    expect(output.calls).toEqual([]);
  });
  it("rejects cancellation before opening the archive", async () => {
    const input = await archive([{ name: "a.txt", data: "a" }]);
    const controller = new AbortController();
    controller.abort();
    await expect(
      importZip(input, sink().target, controller.signal),
    ).rejects.toMatchObject({
      code: "cancelled",
    });
  });
  it("stops during streaming without finishing the file", async () => {
    const input = await archive([{ name: "a.txt", data: "a".repeat(1024) }]);
    const controller = new AbortController();
    const output = sink();
    output.target.appendChunk = (chunk) => {
      output.bytes.push(chunk);
      controller.abort();
      return Promise.resolve();
    };
    await expect(
      importZip(input, output.target, controller.signal),
    ).rejects.toMatchObject({ code: "cancelled" });
    expect(output.calls).toEqual(["begin:/a.txt"]);
  });
  it("reports malformed ZIP bytes without staging a root", async () => {
    const input = new NodeFile([new Uint8Array([1, 2, 3])], "bad.zip");
    const output = sink();
    await expect(importZip(input, output.target)).rejects.toMatchObject({
      code: "invalid-archive",
    });
    expect(output.calls).toEqual([]);
  });
});
