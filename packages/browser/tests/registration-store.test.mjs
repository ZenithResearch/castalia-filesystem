import test from "node:test";
import assert from "node:assert/strict";
import { IDBFactory, IDBObjectStore } from "fake-indexeddb";
import { openDatabase, WORKSPACES, workspaceKey } from "../src/database.mjs";
import { registrationKey, entityKey } from "../src/address.mjs";
import {
  parseWorkspaceRow,
  publishRegistration,
  publishWorkspace,
  loadRegistration,
  acceptReviewedManifest,
  assertAcceptedNamespace,
  parseReviewedManifestIndex,
  publishAcceptedRegistration,
  listAcceptedMounts,
  resolveMount,
  loadLocalReviewedIndex,
  listWorkspaceRows,
} from "../src/registration-store.mjs";
import { PERSON_CLASS } from "../src/registration.mjs";
import {
  trustPolicy,
  otherKey,
  genesis,
  signed,
  verified,
  update,
} from "./registration-fixture.mjs";
const catalog = {
  schema: "castalia.browser-filesystem-catalog.v1",
  head: "ab".repeat(32),
  revisions: [{ root: "ab".repeat(32), committedMs: 1 }],
};
const binding = (r) => ({
  namespaceId: r.manifest.namespaceId,
  entityRef: r.manifest.entityRef,
  registrationGenesisDigest: r.genesisDigest,
});
const index = (r, path = "/Organization/Example/") => ({
  schema: "castalia.reviewed-namespace-index.v1",
  entries: [{ ...binding(r), canonicalPath: path }],
});
async function read(db, key) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(WORKSPACES, "readonly");
    const req = tx.objectStore(WORKSPACES).get(key);
    tx.oncomplete = () => resolve(req.result);
    tx.onabort = () => reject(tx.error);
  });
}
async function write(db, key, value) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(WORKSPACES, "readwrite");
    tx.objectStore(WORKSPACES).put(value, key);
    tx.oncomplete = resolve;
    tx.onabort = () => reject(tx.error);
  });
}
async function setup(overrides = {}) {
  const db = await openDatabase(new IDBFactory());
  const manifest = await genesis(overrides);
  const registration = await verified([signed(manifest)]);
  return { db, manifest, registration };
}

test("genesis publishes one entity, registration and nested v1 catalog without touching legacy", async () => {
  const { db, registration: r } = await setup();
  try {
    await write(db, "workspace", catalog);
    await publishRegistration(db, r, { catalog });
    const row = await read(
      db,
      workspaceKey({
        namespaceId: r.manifest.namespaceId,
        workspaceId: r.manifest.initialWorkspaceId,
      }),
    );
    assert.equal(
      parseWorkspaceRow(row).registrationGenesisDigest,
      r.genesisDigest,
    );
    assert.deepEqual(row.catalog, catalog);
    assert.deepEqual(await read(db, "workspace"), catalog);
    assert.equal(
      (await loadRegistration(db, r.manifest.namespaceId, { trustPolicy }))
        .manifestDigest,
      r.manifestDigest,
    );
    await assert.rejects(
      assertAcceptedNamespace(db, binding(r), index(r), { trustPolicy }),
      /accepted/,
    );
    await acceptReviewedManifest(db, r, index(r));
    assert.equal(
      (await assertAcceptedNamespace(db, binding(r), index(r), { trustPolicy }))
        .manifestDigest,
      r.manifestDigest,
    );
  } finally {
    db.close();
  }
});
test("concurrent genesis has one winner, including deterministic personal root uniqueness", async () => {
  const { db, registration: r } = await setup({
    entityClass: PERSON_CLASS,
    genesisNonce: "00".repeat(32),
  });
  try {
    const another = await verified([
      signed(
        await genesis({
          entityClass: PERSON_CLASS,
          genesisNonce: "00".repeat(32),
          initialWorkspaceId: "33".repeat(32),
        }),
      ),
    ]);
    const result = await Promise.allSettled([
      publishRegistration(db, r, { catalog }),
      publishRegistration(db, another, { catalog }),
    ]);
    assert.equal(result.filter((x) => x.status === "fulfilled").length, 1);
    assert.equal(result.filter((x) => x.status === "rejected").length, 1);
    assert.equal(
      (await read(db, entityKey(r.manifest.entityRef))).namespaceId,
      r.manifest.namespaceId,
    );
    await assert.rejects(
      publishRegistration(db, { ...r }, { catalog }),
      /verified/,
    );
  } finally {
    db.close();
  }
});
test("quota failure after queued writes rolls back every genesis/index/catalog record", async () => {
  const { db, registration: r } = await setup();
  const put = IDBObjectStore.prototype.put;
  IDBObjectStore.prototype.put = function (value, key) {
    if (value?.schema === "castalia.filesystem-workspace.v1")
      throw new DOMException("synthetic quota", "QuotaExceededError");
    return put.call(this, value, key);
  };
  try {
    await assert.rejects(
      publishRegistration(db, r, { catalog, reviewedIndex: index(r) }),
      /quota/,
    );
  } finally {
    IDBObjectStore.prototype.put = put;
  }
  try {
    for (const key of [
      registrationKey(r.manifest.namespaceId),
      entityKey(r.manifest.entityRef),
      workspaceKey({
        namespaceId: r.manifest.namespaceId,
        workspaceId: r.manifest.initialWorkspaceId,
      }),
      ["canonical-mount-v1", "/Organization/Example/"],
    ])
      assert.equal(await read(db, key), undefined);
  } finally {
    db.close();
  }
});
test("request success is not publication success: transaction abort leaves no records", async () => {
  const { db, registration: r } = await setup();
  const put = IDBObjectStore.prototype.put;
  IDBObjectStore.prototype.put = function (value, key) {
    const request = put.call(this, value, key);
    if (value?.schema === "castalia.filesystem-registration-record.v1")
      request.addEventListener("success", () => this.transaction.abort(), {
        once: true,
      });
    return request;
  };
  try {
    await assert.rejects(publishRegistration(db, r, { catalog }));
  } finally {
    IDBObjectStore.prototype.put = put;
  }
  try {
    assert.equal(
      await read(db, registrationKey(r.manifest.namespaceId)),
      undefined,
    );
    assert.equal(await read(db, entityKey(r.manifest.entityRef)), undefined);
  } finally {
    db.close();
  }
});
test("controller update races reject stale acceptance and stale child workspace publication", async () => {
  const { db, manifest, registration: r } = await setup();
  try {
    await publishRegistration(db, r, { catalog, reviewedIndex: index(r) });
    const next = await verified([
      signed(manifest),
      signed(await update(manifest, { controllerMemberKey: otherKey })),
    ]);
    await publishRegistration(db, next);
    await assert.rejects(acceptReviewedManifest(db, r, index(r)), /changed/);
    await assert.rejects(
      publishWorkspace(db, {
        registration: r,
        workspaceId: "44".repeat(32),
        catalog,
      }),
      /changed/,
    );
    await publishRegistration(db, next); // identical durable retry is idempotent
    await publishWorkspace(db, {
      registration: next,
      workspaceId: "44".repeat(32),
      catalog,
    });
    const firstKey = workspaceKey({
      namespaceId: r.manifest.namespaceId,
      workspaceId: r.manifest.initialWorkspaceId,
    });
    const secondKey = workspaceKey({
      namespaceId: r.manifest.namespaceId,
      workspaceId: "44".repeat(32),
    });
    assert.notDeepEqual(firstKey, secondKey);
    assert.equal(
      (await read(db, firstKey)).registrationGenesisDigest,
      (await read(db, secondKey)).registrationGenesisDigest,
    );
    await assert.rejects(
      publishWorkspace(db, {
        registration: next,
        workspaceId: "44".repeat(32),
        catalog,
      }),
      /already exists/,
    );
  } finally {
    db.close();
  }
});
test("reviewed mount class/binding and canonical path collision are enforced independently of names", async () => {
  const { db, registration: r } = await setup();
  try {
    await assert.rejects(
      publishRegistration(db, r, {
        catalog,
        reviewedIndex: index(r, "/Person/Example/"),
      }),
    );
    assert.equal(
      await read(db, registrationKey(r.manifest.namespaceId)),
      undefined,
    );
    await publishRegistration(db, r, { catalog, reviewedIndex: index(r) });
    const other = await verified([
      signed(await genesis({ genesisNonce: "88".repeat(32) })),
    ]);
    await assert.rejects(
      publishRegistration(db, other, { catalog, reviewedIndex: index(other) }),
      /already bound/,
    );
    assert.equal(
      await read(db, registrationKey(other.manifest.namespaceId)),
      undefined,
    );
    await assert.rejects(
      assertAcceptedNamespace(
        db,
        { ...binding(r), registrationGenesisDigest: "99".repeat(32) },
        index(r),
        { trustPolicy },
      ),
    );
    assert.throws(() =>
      parseReviewedManifestIndex({
        schema: "castalia.reviewed-namespace-index.v1",
        entries: [...index(r).entries, ...index(r).entries],
      }),
    );
  } finally {
    db.close();
  }
});
test("unknown stored schema or tampered signed history is never rewritten as recovery", async () => {
  const { db, registration: r } = await setup();
  try {
    await publishRegistration(db, r, { catalog });
    const key = registrationKey(r.manifest.namespaceId),
      raw = await read(db, key);
    await write(db, key, { ...raw, schema: "future.v2" });
    await assert.rejects(
      loadRegistration(db, r.manifest.namespaceId, { trustPolicy }),
    );
    await assert.rejects(publishRegistration(db, r, { catalog }));
    raw.chain[0].manifest.displayName = "Tampered";
    await write(db, key, raw);
    await assert.rejects(
      loadRegistration(db, r.manifest.namespaceId, { trustPolicy }),
    );
  } finally {
    db.close();
  }
});
test("blocked opener rejects and closes a connection that succeeds later", async () => {
  const request = new EventTarget();
  let closed = 0;
  const db = new EventTarget();
  db.close = () => closed++;
  request.result = db;
  const pending = openDatabase({ open: () => request });
  request.dispatchEvent(new Event("blocked"));
  await assert.rejects(pending);
  request.dispatchEvent(new Event("success"));
  assert.equal(closed, 1);
});

test("identical publication is idempotent and never resets an advanced catalog", async () => {
  const { db, registration: r } = await setup();
  try {
    const results = await Promise.all([
      publishRegistration(db, r, { catalog }),
      publishRegistration(db, r, { catalog }),
    ]);
    assert.equal(results.length, 2);
    const key = workspaceKey({
      namespaceId: r.manifest.namespaceId,
      workspaceId: r.manifest.initialWorkspaceId,
    });
    const row = await read(db, key);
    const advanced = {
      schema: catalog.schema,
      head: "cd".repeat(32),
      revisions: [
        ...catalog.revisions,
        { root: "cd".repeat(32), committedMs: 2 },
      ],
    };
    await write(db, key, { ...row, catalog: advanced });
    await publishRegistration(db, r);
    assert.deepEqual((await read(db, key)).catalog, advanced);
    assert.deepEqual(
      await listAcceptedMounts(db, index(r), { trustPolicy }),
      [],
    );
    await assert.rejects(
      publishAcceptedRegistration(db, r, { catalog }),
      /reviewed/,
    );
    await publishAcceptedRegistration(db, r, {
      catalog,
      reviewedIndex: index(r),
    });
    const mounts = await listAcceptedMounts(db, index(r), { trustPolicy });
    assert.equal(mounts.length, 1);
    assert.equal(
      (
        await resolveMount(db, "/Organization/Example/", index(r), {
          trustPolicy,
        })
      ).namespaceId,
      r.manifest.namespaceId,
    );
    assert.equal(
      await resolveMount(db, "/Organization/Zenith/", index(r), {
        trustPolicy,
      }),
      null,
    );
    assert.deepEqual((await read(db, key)).catalog, advanced);
  } finally {
    db.close();
  }
});

test("reload index contains explicit acceptance only and rejects corrupted mount records", async () => {
  const { db, registration: r } = await setup();
  try {
    await publishRegistration(db, r, { catalog });
    assert.deepEqual((await loadLocalReviewedIndex(db)).entries, []);
    await acceptReviewedManifest(db, r, index(r));
    const persisted = await loadLocalReviewedIndex(db);
    assert.deepEqual(persisted, index(r));
    assert.equal(
      (await listAcceptedMounts(db, persisted, { trustPolicy })).length,
      1,
    );
    await write(db, ["canonical-mount-v1", "/Organization/Example/"], {
      ...index(r).entries[0],
      extra: "unknown",
    });
    await assert.rejects(loadLocalReviewedIndex(db));
    await assert.rejects(listAcceptedMounts(db, index(r), { trustPolicy }));
  } finally {
    db.close();
  }
});

test("workspace enumeration isolates namespaces and checks immutable row bindings", async () => {
  const { db, registration: r } = await setup();
  try {
    await write(db, "workspace", catalog);
    await publishRegistration(db, r, { catalog });
    await publishWorkspace(db, {
      registration: r,
      workspaceId: "55".repeat(32),
      catalog,
    });
    const other = await verified([
      signed(await genesis({ genesisNonce: "77".repeat(32) })),
    ]);
    await publishRegistration(db, other, { catalog });
    const rows = await listWorkspaceRows(db, binding(r));
    assert.equal(rows.length, 2);
    assert.ok(
      rows.every((row) => row.address.namespaceId === r.manifest.namespaceId),
    );
    await assert.rejects(
      listWorkspaceRows(db, {
        ...binding(r),
        entityRef: other.manifest.entityRef,
      }),
    );
    const key = workspaceKey(rows[0].address);
    await write(db, key, { ...rows[0], schema: "future.v2" });
    await assert.rejects(listWorkspaceRows(db, binding(r)));
  } finally {
    db.close();
  }
});

test("new genesis without a catalog cannot partially publish", async () => {
  const { db, registration: r } = await setup();
  try {
    await assert.rejects(
      publishAcceptedRegistration(db, r, { reviewedIndex: index(r) }),
      /initial catalog/,
    );
    assert.equal(
      await read(db, registrationKey(r.manifest.namespaceId)),
      undefined,
    );
    assert.deepEqual((await loadLocalReviewedIndex(db)).entries, []);
  } finally {
    db.close();
  }
});

test("reviewed path rename is atomic, reloadable and preserves workspace identity", async () => {
  const { db, registration: r } = await setup();
  try {
    await publishAcceptedRegistration(db, r, {
      catalog,
      reviewedIndex: index(r),
    });
    const key = workspaceKey({
      namespaceId: r.manifest.namespaceId,
      workspaceId: r.manifest.initialWorkspaceId,
    });
    const row = await read(db, key);
    const renamed = index(r, "/Organization/Renamed/");
    await publishAcceptedRegistration(db, r, { reviewedIndex: renamed });
    assert.deepEqual(await loadLocalReviewedIndex(db), renamed);
    assert.deepEqual(await read(db, key), row);
    assert.equal(
      await resolveMount(db, "/Organization/Example/", index(r), {
        trustPolicy,
      }),
      null,
    );
    assert.equal(
      (await listAcceptedMounts(db, renamed, { trustPolicy })).length,
      1,
    );
    await assert.rejects(
      acceptReviewedManifest(db, r, index(r, "/Person/Renamed/")),
      /reviewed/,
    );
    const other = await verified([
      signed(await genesis({ genesisNonce: "88".repeat(32) })),
    ]);
    await publishAcceptedRegistration(db, other, {
      catalog,
      reviewedIndex: index(other, "/Organization/Occupied/"),
    });
    await assert.rejects(
      acceptReviewedManifest(db, r, index(r, "/Organization/Occupied/")),
      /already bound/,
    );
    assert.equal(
      (
        await listAcceptedMounts(db, await loadLocalReviewedIndex(db), {
          trustPolicy,
        })
      ).length,
      2,
    );
    await acceptReviewedManifest(db, r, index(r, "/Organization/Again/"));
    assert.equal(
      await read(db, ["canonical-mount-v1", "/Organization/Renamed/"]),
      undefined,
    );
    assert.deepEqual(await read(db, key), row);
    assert.equal(
      (
        await listAcceptedMounts(db, await loadLocalReviewedIndex(db), {
          trustPolicy,
        })
      ).length,
      2,
    );
  } finally {
    db.close();
  }
});

test("failed alias write rolls back the removed old path", async () => {
  const { db, registration: r } = await setup();
  const put = IDBObjectStore.prototype.put;
  try {
    await publishAcceptedRegistration(db, r, {
      catalog,
      reviewedIndex: index(r),
    });
    IDBObjectStore.prototype.put = function (value, key) {
      if (Array.isArray(key) && key[0] === "canonical-mount-v1")
        throw new DOMException("synthetic quota", "QuotaExceededError");
      return put.call(this, value, key);
    };
    await assert.rejects(
      acceptReviewedManifest(db, r, index(r, "/Organization/Renamed/")),
      /quota/,
    );
    assert.deepEqual(await loadLocalReviewedIndex(db), index(r));
  } finally {
    IDBObjectStore.prototype.put = put;
    db.close();
  }
});

test("cumulative accepted mount cap permits replacement but rejects another namespace atomically", async () => {
  const { db, registration: r } = await setup();
  try {
    await publishAcceptedRegistration(db, r, {
      catalog,
      reviewedIndex: index(r),
    });
    await new Promise((resolve, reject) => {
      const tx = db.transaction(WORKSPACES, "readwrite");
      const store = tx.objectStore(WORKSPACES);
      for (let i = 1; i < 4096; i++) {
        const id = i.toString(16).padStart(64, "0");
        const canonicalPath = `/Organization/Filler${i}/`;
        store.put(
          {
            canonicalPath,
            namespaceId: id,
            entityRef: `urn:castalia:entity:${id}`,
            registrationGenesisDigest: id,
          },
          ["canonical-mount-v1", canonicalPath],
        );
      }
      tx.oncomplete = resolve;
      tx.onabort = () => reject(tx.error);
    });
    await acceptReviewedManifest(db, r, index(r, "/Organization/Renamed/"));
    await acceptReviewedManifest(db, r, index(r, "/Organization/Renamed/"));
    assert.equal((await loadLocalReviewedIndex(db)).entries.length, 4096);
    const other = await verified([
      signed(await genesis({ genesisNonce: "88".repeat(32) })),
    ]);
    await assert.rejects(
      publishAcceptedRegistration(db, other, {
        catalog,
        reviewedIndex: index(other, "/Organization/Overflow/"),
      }),
      /mount count/,
    );
    assert.equal(
      await read(db, registrationKey(other.manifest.namespaceId)),
      undefined,
    );
    assert.equal((await loadLocalReviewedIndex(db)).entries.length, 4096);
  } finally {
    db.close();
  }
});
