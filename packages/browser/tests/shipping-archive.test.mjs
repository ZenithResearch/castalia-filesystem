import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import {
  ZipWriter,
  BlobWriter,
  TextReader,
} from "@zip.js/zip.js/lib/zip-core-native.js";
import { stageInitialWorkspace } from "../src/workspace-storage.mjs";
import { createFilesystemRuntime } from "../src/runtime.mjs";
import {
  createShippingStore,
  SHIPPING_DATABASE,
} from "../src/shipping-store.mjs";
import { unpackShipment, packShipment } from "../src/shipping-archive.mjs";
import { environment, binding, id, putRow } from "./helpers/storage.mjs";
const candidate = process.env.FILESYSTEM_WASM_PACKAGE,
  wasm = candidate
    ? createRequire(import.meta.url)(
        candidate + "/node/castalia_filesystem_wasm.js",
      )
    : null;
const options = { skip: !wasm };
const rt = (env, b = { kind: "legacy" }) =>
  createFilesystemRuntime({
    ...env,
    binding: b,
    wasm,
    assertMount: async () => {},
  });
async function archive() {
  const z = new ZipWriter(new BlobWriter(), { useWebWorkers: false });
  await z.add("hello.txt", new TextReader("hello world"));
  await z.add("private.txt", new TextReader("unselected secret"));
  return new File([await z.close()], "sample.zip");
}
async function stage(env, b) {
  const c = await stageInitialWorkspace({
    ...env,
    address: { namespaceId: b.namespaceId, workspaceId: b.workspaceId },
    wasm,
  });
  await putRow(env.indexedDB, b, c);
  return c;
}
async function init(env, b) {
  const initial = b?.kind === "workspace" ? await stage(env, b) : null;
  const r = rt(env, b),
    catalog = await r.execute(
      initial
        ? {
            operation: "recover",
            expectedHead: initial.head,
            file: await archive(),
          }
        : { operation: "import", file: await archive() },
    );
  return { r, catalog };
}
const read = (r, root, path) =>
  r.execute({ operation: "read", root, path, offset: 0, length: 32 });
test(
  "actual WASM: workspace shipment preserves original snapshot bytes across fresh origin",
  options,
  async () => {
    const source = environment(),
      { r, catalog } = await init(source),
      blob = await r.execute({
        operation: "create-shipment",
        root: catalog.head,
        operationId: id("1"),
      });
    assert.deepEqual(await r.execute({ operation: "verify-shipment", blob }), {
      root: catalog.head,
      path: null,
      kind: "workspace",
    });
    const target = rt(environment()),
      restored = await target.execute({
        operation: "restore-shipment",
        expectedHead: null,
        blob,
      });
    assert.equal(restored.head, catalog.head);
    assert.equal(
      new TextDecoder().decode(await read(target, restored.head, "/hello.txt")),
      "hello world",
    );
    assert.deepEqual(await r.execute({ operation: "catalog" }), catalog);
    await Promise.all([r.dispose(), target.dispose()]);
  },
);
test(
  "actual WASM: a file shipment contains no unselected file payload and restores explicitly",
  options,
  async () => {
    const { r, catalog } = await init(environment()),
      blob = await r.execute({
        operation: "create-shipment",
        root: catalog.head,
        path: "/hello.txt",
        operationId: id("2"),
      });
    const { header, objects } = await unpackShipment(blob, wasm.content_id);
    assert.equal(objects.size, 1);
    assert.equal(header.kind, "file");
    assert.equal(
      new TextDecoder().decode(objects.values().next().value),
      "hello world",
    );
    assert.ok(!(await blob.text()).includes("unselected secret"));
    const target = rt(environment()),
      restored = await target.execute({
        operation: "restore-shipment",
        expectedHead: null,
        blob,
      });
    assert.equal(
      new TextDecoder().decode(await read(target, restored.head, "/hello.txt")),
      "hello world",
    );
    await assert.rejects(read(target, restored.head, "/private.txt"));
    await Promise.all([r.dispose(), target.dispose()]);
  },
);
test(
  "actual WASM: unknown schema, corrupt objects and failed import preserve existing head",
  options,
  async () => {
    const { r, catalog } = await init(environment()),
      blob = await r.execute({
        operation: "create-shipment",
        root: catalog.head,
        operationId: id("3"),
      }),
      { header, objects } = await unpackShipment(blob, wasm.content_id);
    const unknown = packShipment(
      { ...header, schema: "castalia.files-shipment.v9" },
      [...objects.values()],
    );
    await assert.rejects(
      r.execute({
        operation: "restore-shipment",
        expectedHead: catalog.head,
        blob: unknown,
      }),
      { code: "unsupported-version" },
    );
    const corrupt = new Uint8Array(await blob.arrayBuffer());
    corrupt[corrupt.length - 1] ^= 1;
    await assert.rejects(
      r.execute({
        operation: "restore-shipment",
        expectedHead: catalog.head,
        blob: new Blob([corrupt]),
      }),
      { code: "integrity" },
    );
    assert.deepEqual(await r.execute({ operation: "catalog" }), catalog);
    await r.dispose();
  },
);
test(
  "actual WASM: stale import and quota failure preserve source and destination",
  options,
  async () => {
    const a = environment(),
      b = environment(),
      { r: source, catalog: s } = await init(a),
      { r: target, catalog: d } = await init(b),
      blob = await source.execute({
        operation: "create-shipment",
        root: s.head,
        operationId: id("4"),
      });
    await assert.rejects(
      target.execute({
        operation: "restore-shipment",
        expectedHead: null,
        blob,
      }),
      { code: "conflict" },
    );
    const empty = rt({ ...b, storage: environment().storage });
    b.root.faults.quota = true;
    // Use an independent empty physical destination with a quota fault, no existing head.
    const q = environment();
    q.root.faults.quota = true;
    const qr = rt(q);
    await assert.rejects(
      qr.execute({ operation: "restore-shipment", expectedHead: null, blob }),
    );
    assert.equal(await qr.execute({ operation: "catalog" }), null);
    assert.deepEqual(await source.execute({ operation: "catalog" }), s);
    assert.deepEqual(await target.execute({ operation: "catalog" }), d);
    await Promise.all([
      source.dispose(),
      target.dispose(),
      empty.dispose(),
      qr.dispose(),
    ]);
  },
);
test(
  "actual WASM: shipment pins retain roots missing from catalog and release permits bounded cleanup",
  options,
  async () => {
    const env = environment(),
      { r, catalog } = await init(env),
      op = id("5");
    await r.execute({
      operation: "create-shipment",
      root: catalog.head,
      operationId: op,
    });
    const next = await r.execute({
      operation: "revise",
      expectedRoot: catalog.head,
      path: "/hello.txt",
      file: new File(["changed"], "hello.txt"),
    });
    await putRow(
      env.indexedDB,
      { kind: "legacy" },
      {
        ...next,
        revisions: next.revisions.filter((x) => x.root !== catalog.head),
      },
    );
    assert.deepEqual(await r.execute({ operation: "reclaim" }), {
      objects: 0,
      bytes: 0,
    });
    await r.execute({ operation: "release-shipment", operationId: op });
    assert.ok((await r.execute({ operation: "reclaim" })).objects > 0);
    await r.dispose();
  },
);
test(
  "actual WASM: workspace namespace is never reinterpreted and matching workspaces stay isolated",
  options,
  async () => {
    const env = environment(),
      b = binding(),
      { r: one, catalog: c } = await init(env, b),
      blob = await one.execute({
        operation: "create-shipment",
        root: c.head,
        operationId: id("6"),
      }),
      two = rt(env, binding("a", "c")),
      foreign = rt(env, binding("d", "e"));
    const second = await stage(env, binding("a", "c")),
      third = await stage(env, binding("d", "e"));
    const restored = await two.execute({
      operation: "restore-shipment",
      expectedHead: second.head,
      blob,
    });
    assert.equal(restored.head, c.head);
    await assert.rejects(
      foreign.execute({
        operation: "restore-shipment",
        expectedHead: third.head,
        blob,
      }),
      { code: "namespace-mismatch" },
    );
    assert.deepEqual(await foreign.execute({ operation: "catalog" }), third);
    assert.deepEqual(
      await createShippingStore(env.indexedDB).pinnedRoots(binding("a", "c")),
      [],
    );
    await Promise.all([one.dispose(), two.dispose(), foreign.dispose()]);
  },
);
test("late shipping IndexedDB connections close after a blocked open", async () => {
  let request,
    closed = 0;
  const store = createShippingStore({
    open() {
      request = {};
      queueMicrotask(() => request.onblocked());
      return request;
    },
  });
  await assert.rejects(store.load(id("1")), { code: "storage-unavailable" });
  request.result = {
    close() {
      closed++;
    },
  };
  request.onsuccess();
  assert.equal(closed, 1);
});
test("future shipping journal schema blocks cleanup rather than dropping pins", async () => {
  const env = environment(),
    request = env.indexedDB.open(SHIPPING_DATABASE, 2);
  await new Promise((resolve, reject) => {
    request.onsuccess = resolve;
    request.onerror = reject;
  });
  request.result.close();
  await assert.rejects(
    createShippingStore(env.indexedDB).pinnedRoots({ kind: "legacy" }),
    { code: "unsupported-version" },
  );
});
