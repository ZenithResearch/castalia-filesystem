import test from "node:test";
import assert from "node:assert/strict";
import { createCatalog, mutationLockName } from "../src/catalog.mjs";
import { openWorkspaceRoot } from "../src/workspace-storage.mjs";
import { createOpfsObjectWriter } from "../src/opfs-object-writer.mjs";
import { createOpfsObjectReader } from "../src/opfs-object-reader.mjs";
import { reclaimUnusedObjects, budgetReclaimReads } from "../src/reclaim.mjs";
import {
  environment,
  binding,
  catalog,
  id,
  putRow,
} from "./helpers/storage.mjs";

test("workspace catalogs, physical roots and locks are independent; legacy unchanged", async () => {
  const env = environment(),
    a = binding(),
    b = binding("a", "c"),
    c = binding("d", "b"),
    legacy = { kind: "legacy" };
  for (const bound of [a, b, c, legacy])
    await putRow(env.indexedDB, bound, catalog());
  const stores = [a, b, c, legacy].map((bound) => createCatalog(bound, env));
  await stores[0].commitRoot(id("1"), id("2"), 2);
  assert.equal((await stores[0].load()).head, id("2"));
  for (const store of stores.slice(1))
    assert.equal((await store.load()).head, id("1"));
  const roots = await Promise.all(
    [a, b, c, legacy].map((bound) => openWorkspaceRoot(env.storage, bound)),
  );
  assert.equal(new Set(roots).size, 4);
  assert.equal(new Set([a, b, c, legacy].map(mutationLockName)).size, 4);
  const bytes = Uint8Array.of(1, 2, 3),
    hash = () => id("a");
  await createOpfsObjectWriter(roots[0], hash)(bytes);
  await assert.rejects(createOpfsObjectReader(roots[1])(id("a"), 3), {
    code: "missing-object",
  });
  await createOpfsObjectWriter(roots[1], hash)(bytes);
  assert.deepEqual(await createOpfsObjectReader(roots[1])(id("a"), 3), bytes);
  await reclaimUnusedObjects(
    roots[0],
    async () => null,
    async () => "[]",
  );
  assert.deepEqual(await createOpfsObjectReader(roots[1])(id("a"), 3), bytes);
});
test("concurrent catalog CAS has one winner and binding metadata cannot be swapped", async () => {
  const env = environment(),
    b = binding();
  await putRow(env.indexedDB, b, catalog());
  const store = createCatalog(b, env);
  const outcomes = await Promise.allSettled([
    store.commitRoot(id("1"), id("2"), 2),
    store.commitRoot(id("1"), id("3"), 3),
  ]);
  assert.equal(outcomes.filter((x) => x.status === "fulfilled").length, 1);
  await assert.rejects(
    createCatalog(
      { ...b, entityRef: `urn:castalia:entity:${id("9")}` },
      env,
    ).load(),
    { code: "conflict" },
  );
  await assert.rejects(
    createCatalog(binding("a", "d"), env).commitRoot(null, id("4"), 4),
    { code: "conflict" },
  );
});
test("invalid v1 recovery is concurrent-safe and unknown schemas remain untouched", async () => {
  const env = environment(),
    b = binding();
  await putRow(env.indexedDB, b, { ...catalog(), head: "broken" });
  const store = createCatalog(b, env);
  const outcomes = await Promise.allSettled([
    store.recoverInvalid(id("2"), 2),
    store.recoverInvalid(id("3"), 3),
  ]);
  assert.equal(outcomes.filter((x) => x.status === "fulfilled").length, 1);
  await putRow(env.indexedDB, b, { schema: "future.v7", secret: "preserve" });
  await assert.rejects(store.recoverInvalid(id("4"), 4), {
    code: "unsupported-version",
  });
  await assert.rejects(store.load(), { code: "unsupported-version" });
});
test("reclamation validates all entries and its final catalog before any delete", async () => {
  const env = environment(),
    root = await openWorkspaceRoot(env.storage, binding());
  const put = createOpfsObjectWriter(root, () => id("a"));
  await put(Uint8Array.of(1));
  let reads = 0;
  await assert.rejects(
    reclaimUnusedObjects(
      root,
      async () => (++reads === 1 ? null : catalog()),
      async () => "[]",
    ),
    { code: "conflict" },
  );
  assert.equal((await createOpfsObjectReader(root)(id("a"), 1))[0], 1);
  await assert.rejects(
    reclaimUnusedObjects(
      root,
      async () => catalog(),
      async () => JSON.stringify([id("a"), id("b")]),
      { retainedIds: 1, scannedEntries: 1 },
    ),
    { code: "reclaim-unsafe" },
  );
  const read = budgetReclaimReads(async () => Uint8Array.of(1), {
    objectReads: 1,
    bytesRead: 1,
  });
  await read(id("a"), 1);
  await assert.rejects(read(id("a"), 1), { code: "reclaim-limit" });
});
