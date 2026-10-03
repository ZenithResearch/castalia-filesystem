import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CatalogError,
  createLegacyCatalog,
  parseWorkspaceCatalog,
} from "../src/catalog.mjs";
const base = "a".repeat(64);
const next = "b".repeat(64);
describe("filesystem catalog v1", () => {
  it("accepts a bounded revision chain with the latest root selected", () => {
    const record = {
      schema: "castalia.browser-filesystem-catalog.v1",
      head: next,
      revisions: [
        { root: base, committedMs: 1 },
        { root: next, committedMs: 2 },
      ],
    };
    expect(parseWorkspaceCatalog(record)).toEqual(record);
  });
  it.each([
    {
      schema: "castalia.browser-filesystem-catalog.v2",
      head: base,
      revisions: [{ root: base, committedMs: 1 }],
    },
    {
      schema: "castalia.browser-filesystem-catalog.v1",
      head: next,
      revisions: [{ root: base, committedMs: 1 }],
    },
    {
      schema: "castalia.browser-filesystem-catalog.v1",
      head: base,
      revisions: [{ root: base, committedMs: 1 }],
      extra: true,
    },
    {
      schema: "castalia.browser-filesystem-catalog.v1",
      head: base,
      revisions: [
        { root: base, committedMs: 1 },
        { root: base, committedMs: 2 },
      ],
    },
  ])("fails closed on unknown or inconsistent catalog data", (record) => {
    expect(() => parseWorkspaceCatalog(record)).toThrow();
  });
  it("distinguishes a newer schema from damaged v1 data", () => {
    expect(() =>
      parseWorkspaceCatalog({
        schema: "castalia.browser-filesystem-catalog.v3",
      }),
    ).toThrow(new CatalogError("unsupported-version"));
    expect(() =>
      parseWorkspaceCatalog({
        schema: "castalia.browser-filesystem-catalog.v1",
        head: "broken",
        revisions: [],
      }),
    ).toThrow(new CatalogError("invalid"));
  });
});
describe("catalog recovery identity and connection lifecycle", () => {
  afterEach(() => vi.unstubAllGlobals());
  it.each([
    null,
    [],
    "damaged",
    {},
    { schema: null },
    { schema: 1 },
    { head: base, revisions: [] },
  ])(
    "does not classify an unidentified catalog as recoverable v1 corruption",
    (value) => {
      expect(() => parseWorkspaceCatalog(value)).toThrow(
        new CatalogError("unsupported-version"),
      );
    },
  );
  it("closes a database that opens after its blocked request was rejected", async () => {
    const close = vi.fn();
    const database = Object.assign(new EventTarget(), { close });
    const request = Object.assign(new EventTarget(), { result: database });
    vi.stubGlobal("indexedDB", { open: () => request });
    const pending = createLegacyCatalog().load();
    const rejection = expect(pending).rejects.toThrow("unavailable");
    request.dispatchEvent(new Event("blocked"));
    await rejection;
    request.dispatchEvent(new Event("success"));
    expect(close).toHaveBeenCalledOnce();
  });
});
