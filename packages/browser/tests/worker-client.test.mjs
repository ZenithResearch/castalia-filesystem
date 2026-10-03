import test from "node:test";
import assert from "node:assert/strict";
import { installFilesystemWorker } from "../src/worker.mjs";
import { createFilesystemClient } from "../src/filesystem-client.mjs";
import { environment, binding } from "./helpers/storage.mjs";
const legacy = { kind: "legacy" },
  tick = () => new Promise((resolve) => setImmediate(resolve));
function channel() {
  const a = new EventTarget(),
    b = new EventTarget(),
    sent = [];
  const port = {
    addEventListener: b.addEventListener.bind(b),
    removeEventListener: b.removeEventListener.bind(b),
    postMessage(data) {
      sent.push(data);
      queueMicrotask(() =>
        a.dispatchEvent(new MessageEvent("message", { data })),
      );
    },
  };
  const worker = {
    addEventListener: a.addEventListener.bind(a),
    removeEventListener: a.removeEventListener.bind(a),
    postMessage(data) {
      queueMicrotask(() =>
        b.dispatchEvent(new MessageEvent("message", { data })),
      );
    },
    terminate() {
      this.terminated = true;
    },
  };
  return { port, worker, sent };
}
const wasm = {
  PinnedSnapshotReader: class {
    free() {}
  },
  content_id: () => "",
};
test("worker reserves immutable binding during delayed WASM startup and rejects cross-scope commands", async () => {
  const c = channel(),
    env = environment();
  let finish;
  const waiting = new Promise((resolve) => (finish = resolve));
  const dispose = installFilesystemWorker(c.port, { ...env, wasm: waiting });
  c.worker.postMessage({ id: 1, operation: "bind", binding: legacy });
  await tick();
  c.worker.postMessage({ id: 2, operation: "bind", binding: binding() });
  c.worker.postMessage({ id: 3, operation: "catalog", binding: legacy });
  await tick();
  assert.deepEqual(
    c.sent.map((x) => [x.id, x.ok]),
    [
      [2, false],
      [3, false],
    ],
  );
  finish(wasm);
  await tick();
  assert.equal(c.sent.at(-1).id, 1);
  c.worker.postMessage({ id: 4, operation: "catalog", binding: binding() });
  await tick();
  assert.equal(c.sent.at(-1).code, "invalid-request");
  await dispose();
});
test("disposal before delayed WASM resolves never constructs a late runtime or emits ready", async () => {
  const c = channel();
  let finish;
  const dispose = installFilesystemWorker(c.port, {
    wasm: new Promise((resolve) => (finish = resolve)),
  });
  c.worker.postMessage({ id: 1, operation: "bind", binding: legacy });
  await tick();
  await dispose();
  finish(wasm);
  await tick();
  assert.deepEqual(c.sent, []);
});
test("client waits for ready and rejects pending work when terminated", async () => {
  const c = channel(),
    env = environment();
  const dispose = installFilesystemWorker(c.port, { ...env, wasm });
  const client = createFilesystemClient(c.worker, legacy);
  assert.equal(await client.catalog(), null);
  client.destroy();
  await assert.rejects(client.load(), { code: "worker-unavailable" });
  await dispose();
  const other = channel(),
    waiting = createFilesystemClient(other.worker, legacy),
    pending = waiting.load();
  waiting.destroy();
  await assert.rejects(pending, { code: "worker-unavailable" });
  assert.equal(other.worker.terminated, true);
});
test("client binds progress, cancellation and recovery to one immutable worker context", async () => {
  const events = new EventTarget(),
    messages = [];
  const worker = {
    addEventListener: events.addEventListener.bind(events),
    removeEventListener: events.removeEventListener.bind(events),
    postMessage(message) {
      messages.push(message);
    },
    terminate() {},
  };
  const client = createFilesystemClient(worker, legacy);
  events.dispatchEvent(
    new MessageEvent("message", { data: { id: 1, ok: true, value: null } }),
  );
  await client.ready;
  const progress = [];
  const pending = client.recover(
    "a".repeat(64),
    new File(["zip"], "fixture.zip"),
    (v) => progress.push(v.completed),
  );
  await tick();
  const request = messages.at(-1);
  assert.equal(request.operation, "recover");
  assert.equal(request.expectedHead, "a".repeat(64));
  assert.deepEqual(request.binding, legacy);
  events.dispatchEvent(
    new MessageEvent("message", {
      data: {
        id: request.id,
        progress: { completed: 1, total: 2, expandedBytes: 3 },
      },
    }),
  );
  assert.deepEqual(progress, [1]);
  client.cancelImport();
  assert.deepEqual(messages.at(-1), {
    id: 0,
    operation: "cancel-import",
    binding: legacy,
    targetId: request.id,
  });
  events.dispatchEvent(
    new MessageEvent("message", {
      data: { id: request.id, ok: false, code: "cancelled" },
    }),
  );
  await assert.rejects(pending, { code: "cancelled" });
  client.destroy();
});
