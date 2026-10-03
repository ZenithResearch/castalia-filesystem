import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import {
  ZipWriter,
  BlobWriter,
  TextReader,
} from "@zip.js/zip.js/lib/zip-core-native.js";
import { createFilesystemRuntime } from "../src/runtime.mjs";
import {
  stageInitialWorkspace,
  openWorkspaceRoot,
} from "../src/workspace-storage.mjs";
import { createOpfsObjectWriter } from "../src/opfs-object-writer.mjs";
import { createCatalog } from "../src/catalog.mjs";
import { copyLegacyWorkspace } from "../src/legacy-copy.mjs";
import { environment, binding, id, putRow } from "./helpers/storage.mjs";
const candidate = process.env.FILESYSTEM_WASM_PACKAGE;
const wasm = candidate
  ? createRequire(import.meta.url)(
      candidate + "/node/castalia_filesystem_wasm.js",
    )
  : null;
const options = { skip: !wasm };
async function zip(text = "hello", name = "note.txt") {
  const zip = new ZipWriter(new BlobWriter("application/zip"), {
    useWebWorkers: false,
  });
  await zip.add(name, new TextReader(text), {
    lastModDate: new Date("2020-01-01T00:00:00Z"),
    level: 0,
  });
  return new File([await zip.close()], "fixture.zip", {
    type: "application/zip",
  });
}
const runtime = (env, b) =>
  createFilesystemRuntime({
    ...env,
    binding: b,
    wasm,
    assertMount: async () => {},
  });
const client = (r) => ({
  binding: r.binding,
  catalog: () => r.execute({ operation: "catalog" }),
  export: (root) => r.execute({ operation: "export", root }),
  recover: (expectedHead, file) =>
    r.execute({ operation: "recover", expectedHead, file }),
});
test(
  "actual WASM: empty staging, namespace isolation, explicit copy and source preservation",
  options,
  async () => {
    const env = environment(),
      legacy = runtime(env, { kind: "legacy" }),
      bound = binding();
    const source = await legacy.execute({
      operation: "import",
      file: await zip(),
    });
    const staged = await stageInitialWorkspace({
      ...env,
      address: {
        namespaceId: bound.namespaceId,
        workspaceId: bound.workspaceId,
      },
      wasm,
    });
    await putRow(env.indexedDB, bound, staged);
    const target = runtime(env, bound);
    await assert.rejects(
      stageInitialWorkspace({
        ...env,
        address: {
          namespaceId: bound.namespaceId,
          workspaceId: bound.workspaceId,
        },
        wasm,
      }),
      { code: "conflict" },
    );
    await assert.rejects(
      copyLegacyWorkspace({
        source: client(legacy),
        destination: client(target),
        sourceRoot: source.head,
        expectedDestinationHead: staged.head,
        confirmed: false,
      }),
      { code: "invalid" },
    );
    env.root.faults.quota = true;
    await assert.rejects(
      copyLegacyWorkspace({
        source: client(legacy),
        destination: client(target),
        sourceRoot: source.head,
        expectedDestinationHead: staged.head,
        confirmed: true,
      }),
    );
    env.root.faults.quota = false;
    assert.deepEqual(await target.execute({ operation: "catalog" }), staged);
    assert.deepEqual(await legacy.execute({ operation: "catalog" }), source);
    const copied = await copyLegacyWorkspace({
      source: client(legacy),
      destination: client(target),
      sourceRoot: source.head,
      expectedDestinationHead: staged.head,
      confirmed: true,
    });
    assert.equal(
      new TextDecoder().decode(
        await target.execute({
          operation: "read",
          root: copied.head,
          path: "/note.txt",
          offset: 0,
          length: 5,
        }),
      ),
      "hello",
    );
    assert.deepEqual(await legacy.execute({ operation: "catalog" }), source);
    // Even physically present foreign objects do not make a foreign root a selected revision.
    const legacyObjects = await env.root.getDirectoryHandle("objects");
    const selectedRoot = await openWorkspaceRoot(env.storage, bound);
    const writeForeign = createOpfsObjectWriter(selectedRoot, wasm.content_id);
    for await (const prefix of legacyObjects.values())
      for await (const file of prefix.values())
        await writeForeign(
          new Uint8Array(await (await file.getFile()).arrayBuffer()),
        );
    for (const operation of ["read", "list", "stat", "export"])
      await assert.rejects(
        target.execute({
          operation,
          root: source.head,
          path: "/",
          offset: 0,
          length: 1,
        }),
        { code: "conflict" },
      );
    // The snapshot root envelope belongs to the registered namespace, while legacy bytes remain unchanged.
    const targetRoot = await openWorkspaceRoot(env.storage, bound);
    const objects = await targetRoot.getDirectoryHandle("objects");
    const prefix = await objects.getDirectoryHandle(copied.head.slice(0, 2));
    const rootFile = await (await prefix.getFileHandle(copied.head)).getFile();
    assert.match(await rootFile.text(), new RegExp(bound.namespaceId));
    await Promise.all([legacy.dispose(), target.dispose()]);
  },
);
test(
  "actual WASM: quota, malformed ZIP, missing payload and concurrent recovery preserve publication safety",
  options,
  async () => {
    const env = environment(),
      bound = binding();
    const staged = await stageInitialWorkspace({
      ...env,
      address: {
        namespaceId: bound.namespaceId,
        workspaceId: bound.workspaceId,
      },
      wasm,
    });
    await putRow(env.indexedDB, bound, staged);
    const r = runtime(env, bound);
    await assert.rejects(
      r.execute({
        operation: "recover",
        expectedHead: staged.head,
        file: new File(["broken"], "bad.zip"),
      }),
    );
    assert.deepEqual(await createCatalog(bound, env).load(), staged);
    env.root.faults.quota = true;
    await assert.rejects(
      r.execute({
        operation: "recover",
        expectedHead: staged.head,
        file: await zip(),
      }),
    );
    env.root.faults.quota = false;
    assert.deepEqual(await createCatalog(bound, env).load(), staged);
    const results = await Promise.allSettled([
      r.execute({
        operation: "recover",
        expectedHead: staged.head,
        file: await zip("one"),
      }),
      r.execute({
        operation: "recover",
        expectedHead: staged.head,
        file: await zip("two"),
      }),
    ]);
    assert.equal(results.filter((v) => v.status === "fulfilled").length, 1);
    const current = await createCatalog(bound, env).load();
    const root = await openWorkspaceRoot(env.storage, bound);
    const objects = await root.getDirectoryHandle("objects");
    const prefix = await objects.getDirectoryHandle(current.head.slice(0, 2));
    await prefix.removeEntry(current.head);
    await assert.rejects(r.execute({ operation: "load" }));
    const recovered = await r.execute({
      operation: "recover",
      expectedHead: current.head,
      file: await zip("restored"),
    });
    assert.notEqual(recovered.head, current.head);
    await r.dispose();
    await assert.rejects(r.execute({ operation: "catalog" }), {
      code: "storage-unavailable",
    });
  },
);
test(
  "actual WASM: corrupted catalog recovery keeps metadata and unknown schemas fail closed",
  options,
  async () => {
    const env = environment(),
      bound = binding();
    await putRow(env.indexedDB, bound, {
      schema: "castalia.browser-filesystem-catalog.v1",
      head: "bad",
      revisions: [],
    });
    const r = runtime(env, bound);
    const restored = await r.execute({
      operation: "recover-invalid",
      file: await zip(),
    });
    assert.equal(restored.revisions.length, 1);
    await r.dispose();
    await putRow(env.indexedDB, bound, { schema: "future.v9" });
    const future = runtime(env, bound);
    await assert.rejects(
      future.execute({ operation: "recover-invalid", file: await zip() }),
      { code: "unsupported-version" },
    );
    await future.dispose();
  },
);
