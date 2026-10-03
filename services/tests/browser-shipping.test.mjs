import test from "node:test";
import assert from "node:assert/strict";
import { IDBFactory } from "fake-indexeddb";
import { createFilesServer } from "../src/http.mjs";
import { openShippingSession } from "../../packages/browser/src/shipping.mjs";
import { installShippingCryptoWorker } from "../../packages/browser/src/shipping-worker.mjs";
import {
  encryptShipment,
  decryptShipment,
  base64url,
  decodeBase64url,
  FILES_KEY_PROTOCOL,
} from "../../packages/browser/src/shipping-contract.mjs";
import { validateFilesRequest } from "../../packages/browser/src/files-key-contract.mjs";
import {
  registrationManifestDigest,
  verifyRegistrationChain,
  verifiedRegistrationState,
} from "../../packages/browser/src/registration.mjs";
import { signed } from "../../packages/browser/tests/registration-fixture.mjs";
import { createShippingStore } from "../../packages/browser/src/shipping-store.mjs";
import {
  fixture,
  register,
  owner,
  other,
  ownerKey,
  otherKey,
  presentation,
  trustPolicy,
  id,
} from "./helpers.mjs";
class CryptoWorkerDouble {
  constructor() {
    this.listeners = new Map();
    this.workerListeners = new Set();
    this.disposeWorker = installShippingCryptoWorker({
      addEventListener: (_, fn) => this.workerListeners.add(fn),
      removeEventListener: (_, fn) => this.workerListeners.delete(fn),
      postMessage: (value, transfer) => {
        const copy = structuredClone(value, { transfer });
        queueMicrotask(() => this.listeners.get("message")?.({ data: copy }));
      },
    });
  }
  addEventListener(kind, fn) {
    this.listeners.set(kind, fn);
  }
  removeEventListener(kind, fn) {
    if (this.listeners.get(kind) === fn) this.listeners.delete(kind);
  }
  postMessage(value, transfer) {
    const copy = structuredClone(value, { transfer });
    queueMicrotask(() => {
      for (const fn of this.workerListeners) void fn({ data: copy });
    });
  }
  terminate() {
    this.disposeWorker();
    this.listeners.clear();
  }
}
function provider(privateKey = ownerKey, memberKey = owner) {
  const rootKey = new Uint8Array(32).fill(memberKey === owner ? 42 : 43);
  return {
    filesKeyProtocol: FILES_KEY_PROTOCOL,
    getSubject: async () => ({ memberKey }),
    requestFilesServiceAuthentication: async (input) => {
      await validateFilesRequest("authenticate", input, {
        origin: location.origin,
        nowMs: Date.now(),
      });
      return presentation(input.challenge, privateKey);
    },
    wrapFilesKey: async (input) => {
      await validateFilesRequest("wrap", input, {
        origin: location.origin,
        nowMs: Date.now(),
      });
      const encrypted = await encryptShipment(
        decodeBase64url(input.key, 32),
        rootKey,
        input.binding,
      );
      return {
        schema: "castalia.files-key-envelope.v1",
        binding: input.binding,
        nonce: encrypted.nonce,
        ciphertext: base64url(encrypted.ciphertext),
      };
    },
    unwrapFilesKey: async (input) => {
      await validateFilesRequest("unwrap", input, {
        origin: location.origin,
        nowMs: Date.now(),
      });
      const key = await decryptShipment(
        decodeBase64url(input.envelope.ciphertext, 48),
        rootKey,
        input.binding,
        input.envelope.nonce,
      );
      return { key: base64url(key) };
    },
  };
}
async function environment(t, { bytes = 32 } = {}) {
  const f = fixture(t, { realtime: true });
  await register(f);
  const servers = [
    createFilesServer(f.index, { kind: "index" }),
    createFilesServer(f.gateway, { kind: "gateway" }),
  ];
  for (const server of servers)
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    for (const s of servers) await new Promise((resolve) => s.close(resolve));
  });
  const indexUrl = `http://127.0.0.1:${servers[0].address().port}`,
    gatewayUrl = `http://127.0.0.1:${servers[1].address().port}`;
  f.index.gateways.get(f.gateway.gatewayId).gatewayUrl = gatewayUrl + "/";
  const old = {
    fetch: globalThis.fetch,
    indexedDB: globalThis.indexedDB,
    location: globalThis.location,
    navigator: Object.getOwnPropertyDescriptor(globalThis, "navigator"),
  };
  globalThis.indexedDB = new IDBFactory();
  globalThis.location = { origin: "https://app.example" };
  const heldLocks = new Map();
  const locks = {
    async request(name, options, fn) {
      if (options.ifAvailable && heldLocks.has(name)) return fn(null);
      let release;
      const complete = new Promise((resolve) => {
        release = resolve;
      });
      const previous = heldLocks.get(name);
      heldLocks.set(name, complete);
      if (previous) await previous;
      try {
        return await fn({ name, mode: "exclusive" });
      } finally {
        if (heldLocks.get(name) === complete) heldLocks.delete(name);
        release();
      }
    },
  };
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: { locks },
  });
  let intercept = async (input, options, next) => next(input, options);
  globalThis.fetch = (input, options = {}) =>
    intercept(
      input,
      { ...options, headers: { ...options.headers, Origin: location.origin } },
      old.fetch,
    );
  t.after(() => {
    globalThis.fetch = old.fetch;
    globalThis.indexedDB = old.indexedDB;
    globalThis.location = old.location;
    if (old.navigator)
      Object.defineProperty(globalThis, "navigator", old.navigator);
    else delete globalThis.navigator;
  });
  const root = id(321),
    path = null,
    content = new Uint8Array(bytes).fill(3),
    blob = new Blob([content]);
  const config = {
    indexUrl,
    serviceId: f.index.serviceId,
    membershipTrustPolicy: trustPolicy,
    connection: {
      gatewayUrl,
      gatewayId: f.gateway.gatewayId,
      storageAccountId: "synthetic",
      providerName: "Synthetic",
      termsUrl: "https://provider.example/terms",
      budgetBytes: 128 * 1024 * 1024 + 16,
    },
    createCryptoWorker: () => new CryptoWorkerDouble(),
    verifyShipment: async (value) => {
      assert.deepEqual(new Uint8Array(await value.arrayBuffer()), content);
      return { root, path };
    },
  };
  const source = {
    root,
    filesystem: {
      binding: { kind: "legacy" },
      createShipment: async (_root, _path, operationId) => {
        await createShippingStore().pin({ kind: "legacy" }, operationId, root);
        return blob;
      },
      releaseShipment: async (operationId) =>
        createShippingStore().release({ kind: "legacy" }, operationId),
    },
  };
  const sessions = [];
  t.after(() => sessions.forEach((s) => s.dispose()));
  return {
    f,
    config,
    source,
    content,
    setIntercept: (fn) => {
      intercept = fn;
    },
    session: (p = provider()) => {
      const s = openShippingSession(config, p);
      sessions.push(s);
      return s;
    },
    freshOrigin: () => {
      globalThis.indexedDB = new IDBFactory();
      globalThis.location = { origin: "https://zenith.example" };
    },
  };
}
test("browser verifies stored/index receipts; fresh origin restores via the same recoverable key and local changes remain local", async (t) => {
  const env = await environment(t),
    session = env.session();
  await session.connect();
  await session.saveConnection(env.config.connection);
  const shipped = await session.ship({ source: env.source });
  assert.equal(shipped.status, "Shipped");
  assert.equal(session.currentStatus(shipped, id(999)), "Local changes");
  assert.equal(
    (await createShippingStore().pinnedRoots({ kind: "legacy" })).length,
    0,
  );
  session.dispose();
  env.freshOrigin();
  const recovered = env.session();
  assert.equal(
    (await recovered.connect()).personalNamespace.namespaceId,
    shipped.binding.namespaceId,
  );
  assert.equal((await recovered.operations()).length, 0);
  const value = await recovered.retrieve(shipped.binding.submissionId);
  assert.deepEqual(new Uint8Array(await value.blob.arrayBuffer()), env.content);
  const denied = env.session(provider(otherKey, other));
  assert.deepEqual(await denied.listOwn(), []);
  await assert.rejects(denied.retrieve(shipped.binding.submissionId), {
    code: "not-found",
  });
});
test("lost index commit response resumes by operation ID without duplicate storage or head advancement", async (t) => {
  const env = await environment(t),
    session = env.session();
  await session.saveConnection(env.config.connection);
  let lost = false;
  env.setIntercept(async (url, options, next) => {
    const response = await next(url, options);
    if (url.endsWith("/v1/submissions/commit") && !lost) {
      lost = true;
      await response.body.cancel();
      throw new TypeError("synthetic lost response");
    }
    return response;
  });
  await assert.rejects(session.ship({ source: env.source }));
  const [record] = await session.operations();
  assert.equal(record.status, "Shipping");
  assert.ok(env.f.index.operation(owner, record.operationId).acceptance);
  const result = await session.resume(record.operationId);
  assert.equal(result.status, "Shipped");
  assert.equal(env.f.transport.completed, 1);
  assert.equal(env.f.index.inventory(owner)[0].sequence, 1);
});
test("interrupted multipart upload resumes only missing parts from persistent local ciphertext", async (t) => {
  const env = await environment(t, { bytes: 8 * 1024 * 1024 + 32 }),
    session = env.session();
  await session.saveConnection(env.config.connection);
  let interrupted = false,
    firstParts = 0;
  env.setIntercept(async (url, options, next) => {
    if (url.endsWith("/parts/1")) firstParts++;
    if (url.endsWith("/parts/2") && !interrupted) {
      interrupted = true;
      throw new TypeError("synthetic network pause");
    }
    return next(url, options);
  });
  await assert.rejects(session.ship({ source: env.source }));
  const [record] = await session.operations();
  assert.equal(env.f.gateway.status(owner, record.operationId).parts.length, 1);
  assert.equal((await session.resume(record.operationId)).status, "Shipped");
  assert.equal(firstParts, 1);
});
test("invalid gateway receipt cannot become Shipped or an accepted index entry", async (t) => {
  const env = await environment(t),
    session = env.session();
  await session.saveConnection(env.config.connection);
  env.setIntercept(async (url, options, next) => {
    const response = await next(url, options);
    if (url.endsWith("/complete")) {
      const value = await response.json();
      value.signature = "A".repeat(86);
      return new Response(JSON.stringify(value), {
        headers: { "content-type": "application/json" },
      });
    }
    return response;
  });
  await assert.rejects(session.ship({ source: env.source }), {
    code: "invalid-receipt",
  });
  const [record] = await session.operations();
  assert.equal(record.status, "Failed");
  assert.equal(
    env.f.index.operation(owner, record.operationId).acceptance,
    null,
  );
  assert.equal(env.f.index.inventory(owner).length, 0);
});
test("wallet locking during asynchronous archive verification prevents plaintext retrieval", async (t) => {
  const env = await environment(t),
    initial = env.session();
  await initial.saveConnection(env.config.connection);
  const shipped = await initial.ship({ source: env.source });
  initial.dispose();
  let locked = false;
  const p = provider(),
    originalSubject = p.getSubject;
  p.getSubject = async () => {
    if (locked)
      throw Object.assign(new Error("wallet locked"), {
        code: "wallet-locked",
      });
    return originalSubject();
  };
  const originalVerify = env.config.verifyShipment;
  env.config.verifyShipment = async (blob) => {
    const result = await originalVerify(blob);
    await Promise.resolve();
    locked = true;
    return result;
  };
  const restored = env.session(p);
  await assert.rejects(restored.retrieve(shipped.binding.submissionId), {
    code: "wallet-locked",
  });
});
test("connect recovers a crashed preparation pin but never releases another tab’s live preparation", async (t) => {
  const env = await environment(t),
    session = env.session(),
    store = createShippingStore(),
    binding = { kind: "legacy" },
    orphan = id(900),
    live = id(901);
  await store.pin(binding, orphan, env.source.root);
  let unlock, entered;
  const ready = new Promise((resolve) => {
    entered = resolve;
  });
  const gate = new Promise((resolve) => {
    unlock = resolve;
  });
  const holding = navigator.locks.request(
    "castalia-files-shipping-operation-v1:" + live,
    { mode: "exclusive" },
    async () => {
      await store.pin(binding, live, env.source.root);
      entered();
      await gate;
    },
  );
  await ready;
  await session.connect();
  assert.equal((await store.pinnedRoots(binding)).length, 1);
  unlock();
  await holding;
  await session.connect();
  assert.deepEqual(await store.pinnedRoots(binding), []);
});

test("personal discovery rejects a different creator even with a valid registration and index receipt", async (t) => {
  const env = await environment(t),
    otherSession = env.session(provider(otherKey, other));
  env.setIntercept(async (url, options, next) =>
    url.endsWith("/v1/namespaces/personal")
      ? new Response(JSON.stringify(env.f.index.personal(owner)), {
          headers: { "content-type": "application/json" },
        })
      : next(url, options),
  );
  await assert.rejects(otherSession.connect(), {
    code: "registration-mismatch",
  });
});
test("a valid changed-controller personal record is no upload default and does not block existing owner recovery", async (t) => {
  const env = await environment(t),
    initial = env.session();
  await initial.saveConnection(env.config.connection);
  const shipped = await initial.ship({ source: env.source });
  initial.dispose();
  const original = env.f.index.personal(owner),
    previous = original.registration.chain.at(-1).manifest;
  const changed = {
    ...previous,
    controllerMemberKey: other,
    revision: 1,
    previousManifestDigest: await registrationManifestDigest(previous),
  };
  const chain = [...original.registration.chain, signed(changed)];
  const state = verifiedRegistrationState(
    await verifyRegistrationChain(chain, {
      membershipCredential: original.registration.membershipCredential,
      trustPolicy,
    }),
  );
  const response = env.f.index.namespaceResponse(state);
  env.setIntercept(async (url, options, next) =>
    url.endsWith("/v1/namespaces/personal")
      ? new Response(JSON.stringify(response), {
          headers: { "content-type": "application/json" },
        })
      : next(url, options),
  );
  env.freshOrigin();
  const recovered = env.session();
  assert.equal((await recovered.connect()).personalNamespace, null);
  const value = await recovered.retrieve(shipped.binding.submissionId);
  assert.deepEqual(new Uint8Array(await value.blob.arrayBuffer()), env.content);
});
test("browser destination discovery requires canonical namespace and genesis, never an Organization display name", async (t) => {
  const env = await environment(t),
    session = env.session(),
    { manifest, accepted } = await register(env.f, true);
  const personal = env.f.index.personal(owner);
  // Return a valid but not canonically bound organization to exercise the client independently of server filtering.
  env.setIntercept(async (url, options, next) =>
    url.endsWith("/v1/namespaces")
      ? new Response(JSON.stringify([personal, accepted]), {
          headers: { "content-type": "application/json" },
        })
      : next(url, options),
  );
  assert.equal((await session.destinations()).length, 1);
  env.f.index.canonicalBindings = [
    {
      alias: "zenith",
      namespaceId: manifest.namespaceId,
      registrationGenesisDigest:
        accepted.receipt.payload.registrationGenesisDigest,
    },
  ];
  env.f.index.setGrant(owner, {
    namespaceId: manifest.namespaceId,
    granteeMemberKey: owner,
    workspaceId: manifest.initialWorkspaceId,
    actions: ["submit"],
    maxBytes: 1024,
    expiresAt: new Date(Date.now() + 3600000).toISOString(),
  });
  const destinations = await session.destinations();
  assert.equal(destinations.length, 2);
  assert.equal(destinations[1].canonicalAlias, "zenith");
  assert.equal(destinations[1].namespaceId, manifest.namespaceId);
  env.f.index.canonicalBindings[0].registrationGenesisDigest = id(12345);
  assert.equal((await session.destinations()).length, 1);
});

test("lost multipart initiation reply resumes the existing upload without a duplicate initialization", async (t) => {
  const env = await environment(t),
    session = env.session();
  await session.saveConnection(env.config.connection);
  env.f.transport.loseInitialization = true;
  await assert.rejects(session.ship({ source: env.source }));
  const [record] = await session.operations();
  assert.equal(
    env.f.gateway.status(owner, record.operationId).state,
    "initialization-uncertain",
  );
  assert.equal(env.f.transport.counter, 1);
  assert.equal(record.status, "Shipping");
  assert.equal(session.currentStatus(record, id(999)), "Local changes");
  assert.equal(session.currentStatus(record, env.source.root), "Shipping");
  assert.equal(record.status, "Shipping");
  assert.equal((await session.resume(record.operationId)).status, "Shipped");
  assert.equal(env.f.transport.completed, 1);
  assert.equal(env.f.transport.counter, 2);
  assert.equal(env.f.index.inventory(owner)[0].sequence, 1);
});
test("unknown upload status fails closed before initialization retry or part publication", async (t) => {
  const env = await environment(t),
    session = env.session();
  await session.saveConnection(env.config.connection);
  env.f.transport.loseInitialization = true;
  await assert.rejects(session.ship({ source: env.source }));
  const [record] = await session.operations();
  let retried = 0,
    parts = 0;
  env.setIntercept(async (url, options, next) => {
    if (options.method === "POST" && url.endsWith("/v1/uploads")) retried++;
    if (options.method === "PUT") parts++;
    const response = await next(url, options);
    if (
      options.method === "GET" &&
      url.endsWith("/v1/uploads/" + record.operationId)
    ) {
      const value = await response.json();
      value.state = "future-initialization";
      return new Response(JSON.stringify(value), {
        headers: { "content-type": "application/json" },
      });
    }
    return response;
  });
  await assert.rejects(session.resume(record.operationId), {
    code: "invalid-response",
  });
  assert.equal(retried, 0);
  assert.equal(parts, 0);
  assert.equal(env.f.index.inventory(owner).length, 0);
});
