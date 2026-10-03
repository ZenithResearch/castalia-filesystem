import test from "node:test";
import assert from "node:assert/strict";
import { backupDatabase } from "../src/common.mjs";
import { join } from "node:path";
import { FilesIndex } from "../src/index.mjs";
import {
  fixture,
  register,
  intent,
  stored,
  commitInput,
  owner,
  other,
  id,
} from "./helpers.mjs";
import { verifyReleaseArchive } from "../scripts/s3d-launcher.mjs";
test("transaction-consistent SQLite backup restores registrations, accepted heads and owner recovery metadata", async (t) => {
  const f = fixture(t),
    { manifest } = await register(f),
    shipment = intent(f, manifest),
    storageReceipt = await stored(f, shipment);
  const acceptance = f.index.commit(
    owner,
    commitInput(shipment, storageReceipt),
  );
  const path = join(f.indexOptions.databasePath + "-snapshot.sqlite");
  await backupDatabase(f.index.db, path);
  const restored = new FilesIndex({ ...f.indexOptions, databasePath: path });
  try {
    assert.deepEqual(restored.operation(owner, id(1)).acceptance, acceptance);
    assert.equal(
      restored.personal(owner).registration.chain[0].manifest.namespaceId,
      manifest.namespaceId,
    );
    assert.equal(restored.inventory(owner).length, 1);
    assert.deepEqual(restored.inventory(other), []);
  } finally {
    restored.close();
  }
});
test("operator launcher rejects corrupted and unknown platform archives before extraction or execution", () => {
  assert.throws(
    () =>
      verifyReleaseArchive(Buffer.from("not a release"), {
        platform: "darwin",
        arch: "arm64",
      }),
    /checksum mismatch/,
  );
  assert.throws(
    () =>
      verifyReleaseArchive(Buffer.alloc(0), { platform: "win32", arch: "x64" }),
    /Unsupported/,
  );
});
