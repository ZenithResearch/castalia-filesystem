// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  ShippingError,
  FILES_KEY_PROTOCOL,
  SHIPPING_LIMITS,
  exactObject,
  hexId,
  randomId,
  parseFilesKeyBinding,
  parseFilesKeyEnvelope,
  assertSameBinding,
  sha256Hex,
  canonicalJson,
  base64url,
  decodeBase64url,
} from "./shipping-contract.mjs";
import {
  buildFilesConsent,
  parseFilesBody,
  filesWebOrigin,
} from "./files-key-contract.mjs";
import { createShippingStore } from "./shipping-store.mjs";
import { createShippingCryptoClient } from "./shipping-worker.mjs";
import {
  parseUploadIntent,
  parseStorageReceipt,
  parseIndexAcceptance,
  parseNamespaceAcceptance,
  verifyServiceEnvelope,
  serviceEnvelopeDigest,
} from "./shipping-receipts.mjs";
import {
  verifyRegistrationChain,
  PERSON_CLASS,
  ORGANIZATION_CLASS,
} from "./registration.mjs";
import { mutationLockName } from "./catalog.mjs";
const encoder = new TextEncoder();
function fail(code, message = code) {
  throw new ShippingError(code, message);
}
function serviceUrl(value) {
  if (typeof value !== "string") fail("invalid-config");
  let u;
  try {
    u = new URL(value);
  } catch {
    fail("invalid-config");
  }
  filesWebOrigin(u.origin);
  if (u.username || u.password || u.search || u.hash || u.pathname !== "/")
    fail("invalid-config");
  return u.origin;
}
export function parseStorageConnection(value) {
  exactObject(value, [
    "gatewayUrl",
    "gatewayId",
    "storageAccountId",
    "providerName",
    "termsUrl",
    "budgetBytes",
  ]);
  const gatewayUrl = serviceUrl(value.gatewayUrl);
  hexId(value.gatewayId);
  if (
    typeof value.storageAccountId !== "string" ||
    !/^[A-Za-z0-9._~-]{1,128}$/.test(value.storageAccountId) ||
    typeof value.providerName !== "string" ||
    !value.providerName.trim() ||
    value.providerName.length > 128 ||
    /[\p{Cc}\p{Cs}]/u.test(value.providerName) ||
    !Number.isSafeInteger(value.budgetBytes) ||
    value.budgetBytes < 0
  )
    fail("invalid-config");
  let terms;
  try {
    terms = new URL(value.termsUrl);
  } catch {
    fail("invalid-config");
  }
  if (
    terms.protocol !== "https:" ||
    terms.username ||
    terms.password ||
    value.termsUrl.length > 2048
  )
    fail("invalid-config");
  return Object.freeze({ ...value, gatewayUrl });
}
export function parseShippingConfig(value) {
  const fields = [
    "indexUrl",
    "serviceId",
    "membershipTrustPolicy",
    "createCryptoWorker",
    "verifyShipment",
  ];
  exactObject(
    value,
    Object.hasOwn(value ?? {}, "connection")
      ? [...fields, "connection"]
      : fields,
  );
  if (
    typeof value.createCryptoWorker !== "function" ||
    typeof value.verifyShipment !== "function" ||
    !value.membershipTrustPolicy
  )
    fail("invalid-config");
  return Object.freeze({
    ...value,
    indexUrl: serviceUrl(value.indexUrl),
    serviceId: hexId(value.serviceId),
    ...(value.connection
      ? { connection: parseStorageConnection(value.connection) }
      : {}),
  });
}
function publicRecord(r) {
  return Object.freeze({
    operationId: r.operationId,
    binding: r.binding,
    sourceRoot: r.sourceRoot,
    sourcePath: r.sourcePath,
    status: r.status,
    detail: r.detail,
    updatedAt: r.updatedAt,
    ...(r.receipt ? { receipt: r.receipt } : {}),
    ...(r.error ? { error: r.error } : {}),
  });
}
async function boundedBytes(response, limit) {
  const declared = response.headers.get("content-length");
  if (
    declared !== null &&
    (!/^\d+$/.test(declared) || Number(declared) > limit)
  )
    fail("limit");
  const reader = response.body?.getReader();
  if (!reader) fail("missing-payload");
  const chunks = [];
  let count = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      count += value.length;
      if (count > limit) fail("limit");
      chunks.push(value);
    }
  } catch (e) {
    await reader.cancel().catch(() => {});
    throw e;
  } finally {
    reader.releaseLock();
  }
  if (declared !== null && Number(declared) !== count) fail("integrity");
  const bytes = new Uint8Array(count);
  let offset = 0;
  for (const x of chunks) {
    bytes.set(x, offset);
    offset += x.length;
  }
  return bytes;
}
/** A session belongs to one origin and one selected custody provider. Never persist bearer tokens or keys. */
export function openShippingSession(rawConfig, provider) {
  const config = parseShippingConfig(rawConfig),
    origin = filesWebOrigin(globalThis.location?.origin);
  if (
    provider?.filesKeyProtocol !== FILES_KEY_PROTOCOL ||
    [
      "getSubject",
      "wrapFilesKey",
      "unwrapFilesKey",
      "requestFilesServiceAuthentication",
    ].some((k) => typeof provider[k] !== "function")
  )
    fail("provider-unavailable");
  const store = createShippingStore(),
    sessions = new Map(),
    listeners = new Set(),
    active = new Set(),
    requests = new Set();
  const cryptoClient = createShippingCryptoClient(config.createCryptoWorker());
  let closed = false,
    owner,
    connection = config.connection ?? null,
    connecting;
  const check = (signal) => {
    if (closed) fail("disposed");
    if (signal?.aborted) fail("cancelled");
  };
  async function request(
    url,
    path,
    {
      method = "GET",
      body,
      token,
      signal,
      bytes = false,
      allowMissing = false,
    } = {},
  ) {
    check(signal);
    const controller = new AbortController();
    requests.add(controller);
    const stop = () => controller.abort();
    signal?.addEventListener("abort", stop, { once: true });
    const timer = setTimeout(stop, 180000);
    try {
      const headers = {
        ...(token ? { Authorization: "Bearer " + token } : {}),
        ...(body !== undefined
          ? {
              "Content-Type":
                body instanceof Uint8Array
                  ? "application/octet-stream"
                  : "application/json",
            }
          : {}),
      };
      const response = await fetch(url + path, {
        method,
        headers,
        body:
          body === undefined
            ? undefined
            : body instanceof Uint8Array
              ? body
              : JSON.stringify(body),
        credentials: "omit",
        cache: "no-store",
        redirect: "error",
        signal: controller.signal,
      });
      check(signal);
      if (allowMissing && response.status === 404) {
        await response.body?.cancel();
        return null;
      }
      const raw = await boundedBytes(
        response,
        bytes ? SHIPPING_LIMITS.ciphertextBytes : 2 * 1024 * 1024,
      );
      check(signal);
      if (bytes && response.ok) return raw;
      let value;
      try {
        value = JSON.parse(
          new TextDecoder("utf-8", { fatal: true }).decode(raw),
        );
      } catch {
        fail("invalid-response");
      }
      if (!response.ok)
        fail(typeof value.error === "string" ? value.error : "service-failed");
      return value;
    } finally {
      clearTimeout(timer);
      requests.delete(controller);
      signal?.removeEventListener("abort", stop);
    }
  }
  async function currentOwner() {
    check();
    const subject = await provider.getSubject();
    check();
    const key =
      subject.dreggOwnerPublicKey ??
      subject.memberKey ??
      subject.subjectId?.replace(/^did:castalia:member:/, "");
    hexId(key);
    if (owner && key !== owner) fail("identity-changed");
    owner = key;
    return key;
  }
  async function login(kind, url, id, signal) {
    check(signal);
    await currentOwner();
    const saved = sessions.get(id);
    if (saved && saved.expires > Date.now() + 5000) return saved.token;
    const challenge = await request(url, "/v1/auth/challenge", {
      method: "POST",
      body: { memberKey: owner },
      signal,
    });
    const body = parseFilesBody("authenticate", {
      serviceKind: kind,
      serviceId: id,
      challenge,
    });
    if (body.challenge.origin !== origin) fail("origin-mismatch");
    const consent = await buildFilesConsent("authenticate", body, origin);
    const presentation = await provider.requestFilesServiceAuthentication({
      ...body,
      consent,
    });
    check(signal);
    await currentOwner();
    const accepted = await request(url, "/v1/auth/session", {
      method: "POST",
      body: { presentation },
      signal,
    });
    if (
      accepted.memberKey !== owner ||
      typeof accepted.token !== "string" ||
      !/^[A-Za-z0-9_-]{43}$/.test(accepted.token) ||
      !Number.isFinite(Date.parse(accepted.expiresAt)) ||
      Date.parse(accepted.expiresAt) <= Date.now() ||
      Date.parse(accepted.expiresAt) > Date.now() + 900000
    )
      fail("invalid-session");
    sessions.set(id, {
      token: accepted.token,
      expires: Date.parse(accepted.expiresAt),
      url,
    });
    return accepted.token;
  }
  const index = async (path, options = {}) =>
    request(config.indexUrl, path, {
      ...options,
      token: await login(
        "index",
        config.indexUrl,
        config.serviceId,
        options.signal,
      ),
    });
  const gateway = async (conn, path, options = {}) =>
    request(conn.gatewayUrl, path, {
      ...options,
      token: await login(
        "gateway",
        conn.gatewayUrl,
        conn.gatewayId,
        options.signal,
      ),
    });
  function allowedConnection(value) {
    const c = parseStorageConnection(value);
    if (
      !config.connection ||
      c.gatewayUrl !== config.connection.gatewayUrl ||
      c.gatewayId !== config.connection.gatewayId
    )
      fail("unconfigured-gateway");
    return c;
  }
  async function decodeNamespace(value, personalOwner) {
    if (value === null) return null;
    exactObject(value, ["registration", "receipt"]);
    exactObject(value.registration, ["chain", "membershipCredential"]);
    const state = await verifyRegistrationChain(value.registration.chain, {
      membershipCredential: value.registration.membershipCredential,
      trustPolicy: config.membershipTrustPolicy,
    });
    const p = await verifyServiceEnvelope(
        value.receipt,
        config.serviceId,
        parseNamespaceAcceptance,
      ),
      m = state.manifest;
    const expected = {
      serviceId: config.serviceId,
      manifestDigest: state.manifestDigest,
      registrationGenesisDigest: state.genesisDigest,
      namespaceId: m.namespaceId,
      workspaceId: m.initialWorkspaceId,
      entityRef: m.entityRef,
      controllerMemberKey: m.controllerMemberKey,
    };
    for (const [k, v] of Object.entries(expected))
      if (p[k] !== v) fail("registration-mismatch");
    if (personalOwner && m.entityClass === PERSON_CLASS) {
      if (m.creatorMemberKey !== personalOwner) fail("registration-mismatch");
      if (m.controllerMemberKey !== personalOwner) return null;
    }
    return Object.freeze({
      entityRef: m.entityRef,
      entityClass: m.entityClass,
      displayName: m.displayName,
      namespaceId: m.namespaceId,
      workspaceId: m.initialWorkspaceId,
      registrationGenesisDigest: state.genesisDigest,
      controllerMemberKey: m.controllerMemberKey,
    });
  }
  async function personalNamespace() {
    const personalOwner = await currentOwner();
    const d = await decodeNamespace(
      await index("/v1/namespaces/personal"),
      personalOwner,
    );
    if (d && d.entityClass !== PERSON_CLASS) fail("registration-mismatch");
    return d
      ? Object.freeze({ ...d, canSubmit: true, canUpdateOwn: true })
      : null;
  }
  async function connections() {
    const values = await index("/v1/connections");
    if (!Array.isArray(values) || values.length > 128) fail("limit");
    return values.map(allowedConnection);
  }
  async function connect() {
    if (connecting) return connecting;
    connecting = (async () => {
      await currentOwner();
      await store.recoverPreparations(globalThis.navigator?.locks);
      const personal = await personalNamespace();
      const saved = await connections();
      if (saved.length)
        connection =
          saved.find(
            (v) =>
              connection && v.storageAccountId === connection.storageAccountId,
          ) ?? saved[0];
      return { ownerMemberKey: owner, personalNamespace: personal, connection };
    })();
    try {
      return await connecting;
    } finally {
      connecting = undefined;
    }
  }
  async function saveConnection(value) {
    const next = allowedConnection(value);
    await index("/v1/connections", { method: "PUT", body: next });
    connection = next;
  }
  async function acceptRegistration(chain, membershipCredential) {
    return decodeNamespace(
      await index("/v1/registrations/accept", {
        method: "POST",
        body: { chain, membershipCredential, expectedManifestDigest: null },
      }),
    );
  }
  async function destinations() {
    const personalOwner = await currentOwner();
    const values = await index("/v1/namespaces");
    const discovery = await index("/v1/destinations");
    if (!Array.isArray(values) || values.length > 1024) fail("limit");
    exactObject(discovery, ["personal", "zenith"]);
    const zenith = discovery.zenith;
    let canUpdateOwn = false;
    if (zenith?.state === "pending") {
      exactObject(zenith, ["state", "reason"]);
      if (typeof zenith.reason !== "string" || zenith.reason.length > 1024)
        fail("invalid-response");
    } else if (zenith?.state === "registered") {
      exactObject(zenith, [
        "state",
        "namespaceId",
        "registrationGenesisDigest",
        "canSubmit",
        ...(Object.hasOwn(zenith, "canUpdateOwn") ? ["canUpdateOwn"] : []),
      ]);
      hexId(zenith.namespaceId);
      hexId(zenith.registrationGenesisDigest);
      if (typeof zenith.canSubmit !== "boolean") fail("invalid-response");
      if (Object.hasOwn(zenith, "canUpdateOwn")) {
        if (typeof zenith.canUpdateOwn !== "boolean") fail("invalid-response");
        canUpdateOwn = zenith.canUpdateOwn;
      }
    } else fail("invalid-response");
    const result = [];
    for (const value of values) {
      const destination = await decodeNamespace(value, personalOwner);
      if (!destination) continue;
      if (destination.entityClass === PERSON_CLASS)
        result.push(
          Object.freeze({
            ...destination,
            canSubmit: true,
            canUpdateOwn: true,
          }),
        );
      else if (
        destination.entityClass === ORGANIZATION_CLASS &&
        zenith.state === "registered" &&
        (zenith.canSubmit || canUpdateOwn) &&
        destination.namespaceId === zenith.namespaceId &&
        destination.registrationGenesisDigest ===
          zenith.registrationGenesisDigest
      )
        result.push(
          Object.freeze({
            ...destination,
            canonicalAlias: "zenith",
            canSubmit: zenith.canSubmit,
            canUpdateOwn,
          }),
        );
    }
    return result;
  }
  async function save(record, blob) {
    check();
    record.updatedAt = new Date().toISOString();
    await store.save(record, blob);
    check();
    const v = publicRecord(record);
    for (const fn of listeners) {
      try {
        fn(v);
      } catch {}
    }
    return v;
  }
  async function unwrap(binding, envelope, signal) {
    const body = { binding, envelope: parseFilesKeyEnvelope(envelope) };
    assertSameBinding(binding, body.envelope.binding);
    const consent = await buildFilesConsent("unwrap", body, origin);
    const result = await provider.unwrapFilesKey({ ...body, consent });
    const key = decodeBase64url(result.key, 32);
    try {
      check(signal);
      await currentOwner();
      return key;
    } catch (e) {
      key.fill(0);
      throw e;
    }
  }
  async function decodeBytes(bytes, binding, envelope, nonce, signal) {
    let key, plain;
    try {
      key = await unwrap(binding, envelope, signal);
      plain = await cryptoClient.decrypt(bytes, key, binding, nonce, signal);
      check(signal);
      await currentOwner();
      const blob = new Blob([plain]);
      plain.fill(0);
      const verified = await config.verifyShipment(blob);
      check(signal);
      await currentOwner();
      check(signal);
      return { blob, verified };
    } finally {
      if (plain?.byteLength) plain.fill(0);
      if (key?.byteLength) key.fill(0);
    }
  }
  function matchStorage(p, r) {
    const expected = {
      operationId: r.operationId,
      ownerMemberKey: r.binding.ownerMemberKey,
      storageAccountId: r.binding.storageAccountId,
      gatewayId: r.connection.gatewayId,
      ciphertextSha256: r.ciphertextSha256,
      byteLength: r.byteLength,
    };
    for (const [k, v] of Object.entries(expected))
      if (p[k] !== v) fail("receipt-mismatch");
  }
  async function matchAcceptance(receipt, r) {
    const p = await verifyServiceEnvelope(
      receipt,
      config.serviceId,
      parseIndexAcceptance,
    );
    const expected = {
      operationId: r.operationId,
      ownerMemberKey: r.binding.ownerMemberKey,
      serviceId: r.binding.serviceId,
      namespaceId: r.binding.namespaceId,
      workspaceId: r.binding.workspaceId,
      registrationGenesisDigest: r.registrationGenesisDigest,
      submissionId: r.binding.submissionId,
      revisionId: r.binding.revisionId,
      previousRevisionId: r.previousRevisionId,
      descriptorDigest: r.descriptorDigest,
      storageReceiptDigest: await serviceEnvelopeDigest(r.storageReceipt),
    };
    for (const [k, v] of Object.entries(expected))
      if (p[k] !== v) fail("receipt-mismatch");
    return p;
  }
  async function freshRead(r, signal) {
    const p = await verifyServiceEnvelope(
      r.storageReceipt,
      r.connection.gatewayId,
      parseStorageReceipt,
    );
    matchStorage(p, r);
    const bytes = await gateway(r.connection, "/v1/objects/" + r.operationId, {
      bytes: true,
      signal,
    });
    if (
      bytes.length !== r.byteLength ||
      (await sha256Hex(bytes)) !== r.ciphertextSha256
    )
      fail("integrity");
    const result = await decodeBytes(
      bytes,
      r.binding,
      r.keyEnvelope,
      r.nonce,
      signal,
    );
    if (
      r.sourceRoot !== undefined &&
      (result.verified.root !== r.sourceRoot ||
        result.verified.path !== r.sourcePath)
    )
      fail("source-mismatch");
    return result;
  }
  async function perform(record, signal) {
    if (!globalThis.navigator?.locks?.request) fail("storage-unavailable");
    return navigator.locks.request(
      "castalia-files-shipping-operation-v1:" + record.operationId,
      { mode: "exclusive", ...(signal ? { signal } : {}) },
      async () => {
        check(signal);
        const latest = await store.load(record.operationId);
        return performLocked(latest ?? record, signal);
      },
    );
  }
  async function performLocked(record, signal) {
    if (active.has(record.operationId)) fail("busy");
    active.add(record.operationId);
    try {
      check(signal);
      await currentOwner();
      if (
        record.binding.ownerMemberKey !== owner ||
        record.binding.serviceId !== config.serviceId
      )
        fail("owner-mismatch");
      record.connection = allowedConnection(record.connection);
      record.status = "Shipping";
      record.detail = "Checking completion";
      delete record.error;
      await save(record);
      const found = await index("/v1/operations/" + record.operationId, {
        allowMissing: true,
        signal,
      });
      if (found?.intent) {
        const p = await verifyServiceEnvelope(
          found.intent,
          config.serviceId,
          parseUploadIntent,
        );
        assertSameBinding(p.binding, record.binding);
        if (
          p.operationId !== record.operationId ||
          p.ciphertextSha256 !== record.ciphertextSha256 ||
          p.expectedRevisionId !== record.previousRevisionId ||
          p.byteLength !== record.byteLength ||
          p.gatewayId !== record.connection.gatewayId ||
          p.registrationGenesisDigest !== record.registrationGenesisDigest
        )
          fail("intent-mismatch");
        record.intent = found.intent;
      }
      if (!record.intent)
        record.intent = await index("/v1/upload-intents", {
          method: "POST",
          signal,
          body: {
            operationId: record.operationId,
            binding: record.binding,
            expectedRevisionId: record.previousRevisionId,
            ciphertextSha256: record.ciphertextSha256,
            byteLength: record.byteLength,
            gatewayId: record.connection.gatewayId,
          },
        });
      const intent = await verifyServiceEnvelope(
        record.intent,
        config.serviceId,
        parseUploadIntent,
      );
      assertSameBinding(intent.binding, record.binding);
      if (
        intent.registrationGenesisDigest !== record.registrationGenesisDigest ||
        intent.operationId !== record.operationId ||
        intent.ciphertextSha256 !== record.ciphertextSha256 ||
        intent.byteLength !== record.byteLength ||
        intent.gatewayId !== record.connection.gatewayId ||
        intent.expectedRevisionId !== record.previousRevisionId
      )
        fail("intent-mismatch");
      await save(record);
      if (!record.storageReceipt) {
        let state = await gateway(
          record.connection,
          "/v1/uploads/" + record.operationId,
          { allowMissing: true, signal },
        );
        const validateState = (value) => {
          exactObject(value, [
            "operationId",
            "state",
            "partBytes",
            "parts",
            "receipt",
          ]);
          if (
            value.operationId !== record.operationId ||
            value.partBytes !== SHIPPING_LIMITS.partBytes ||
            !Array.isArray(value.parts) ||
            ![
              "initializing",
              "initialization-uncertain",
              "uploading",
              "completion-uncertain",
              "verifying",
              "stored",
            ].includes(value.state) ||
            (value.state === "stored") !== (value.receipt !== null) ||
            (["initializing", "initialization-uncertain"].includes(
              value.state,
            ) &&
              value.parts.length !== 0)
          )
            fail("invalid-response");
        };
        if (state !== null) validateState(state);
        // The gateway owns initiation reconciliation. Reuse this exact signed intent;
        // a missing initiation response must not strand its existing multipart upload.
        if (
          state === null ||
          ["initializing", "initialization-uncertain"].includes(state.state)
        ) {
          state = await gateway(record.connection, "/v1/uploads", {
            method: "POST",
            body: { intent: record.intent },
            signal,
          });
          validateState(state);
          if (
            ["initializing", "initialization-uncertain"].includes(state.state)
          )
            fail("initialization-uncertain");
        }
        if (!state.receipt) {
          record.detail = "Uploading encrypted parts";
          await save(record);
          const cipher = await store.ciphertext(record.operationId);
          if (
            cipher.size !== record.byteLength ||
            (await sha256Hex(await cipher.arrayBuffer())) !==
              record.ciphertextSha256
          )
            fail("integrity");
          const count = Math.ceil(cipher.size / SHIPPING_LIMITS.partBytes);
          if (state.parts.length > count) fail("invalid-response");
          for (let part = 1; part <= count; part++) {
            check(signal);
            const bytes = new Uint8Array(
                await cipher
                  .slice(
                    (part - 1) * SHIPPING_LIMITS.partBytes,
                    part * SHIPPING_LIMITS.partBytes,
                  )
                  .arrayBuffer(),
              ),
              hash = await sha256Hex(bytes),
              present = state.parts.filter((x) => x.partNumber === part);
            if (
              present.length > 1 ||
              present.some(
                (x) => x.sha256 !== hash || x.byteLength !== bytes.length,
              )
            )
              fail("part-conflict");
            if (!present.length) {
              const accepted = await gateway(
                record.connection,
                `/v1/uploads/${record.operationId}/parts/${part}`,
                { method: "PUT", body: bytes, signal },
              );
              if (
                accepted.partNumber !== part ||
                accepted.sha256 !== hash ||
                accepted.byteLength !== bytes.length
              )
                fail("part-conflict");
            }
          }
          record.detail = "Confirming host storage";
          await save(record);
          const result = await gateway(
            record.connection,
            `/v1/uploads/${record.operationId}/complete`,
            { method: "POST", body: {}, signal },
          );
          // complete returns the signed receipt; status returns it within an operation record.
          record.storageReceipt = result;
        } else record.storageReceipt = state.receipt;
        matchStorage(
          await verifyServiceEnvelope(
            record.storageReceipt,
            record.connection.gatewayId,
            parseStorageReceipt,
          ),
          record,
        );
        await save(record);
      }
      record.detail = "Verifying fresh retrieval";
      await save(record);
      await freshRead(record, signal);
      record.detail = "Awaiting namespace acceptance";
      await save(record);
      // A lost commit response is reconciled by this stable operation ID before any retry.
      const latest = await index("/v1/operations/" + record.operationId, {
        signal,
      });
      const receipt =
        latest.acceptance ??
        (await index("/v1/submissions/commit", {
          method: "POST",
          signal,
          body: {
            operationId: record.operationId,
            storageReceipt: record.storageReceipt,
            descriptorDigest: record.descriptorDigest,
            keyEnvelope: record.keyEnvelope,
            nonce: record.nonce,
          },
        }));
      await matchAcceptance(receipt, record);
      record.receipt = receipt;
      record.status = "Shipped";
      record.detail = "Stored bytes and namespace acceptance verified";
      return navigator.locks.request(
        mutationLockName(record.sourceBinding),
        { mode: "exclusive" },
        () => save(record),
      );
    } catch (error) {
      if (!closed) {
        record.status = [
          "invalid-receipt",
          "namespace-admission-denied",
          "account-admission-denied",
          "storage-budget-exceeded",
          "owner-storage-budget-exceeded",
          "storage-binding-mismatch",
          "stored-integrity-mismatch",
          "stored-size-mismatch",
          "intent-expired",
          "intent-denied",
          "head-conflict",
          "authority-denied",
          "invalid",
          "integrity",
          "receipt-mismatch",
          "owner-mismatch",
          "intent-mismatch",
          "quota",
          "untrusted-gateway",
          "namespace-admission-denied",
          "owner-storage-budget-exceeded",
          "operation-conflict",
          "part-conflict",
          "invalid-journal",
          "registration-mismatch",
          "storage-binding-mismatch",
        ].includes(error?.code)
          ? "Failed"
          : "Shipping";
        record.detail =
          record.status === "Shipping"
            ? "Paused — checking completion before retry"
            : "Needs explicit resolution";
        record.error = String(error?.code ?? "connection-interrupted");
        await save(record).catch(() => {});
      }
      throw error;
    } finally {
      active.delete(record.operationId);
    }
  }
  async function ship({
    source,
    destination,
    submissionId,
    previousRevisionId = null,
    signal,
  } = {}) {
    check(signal);
    await connect();
    if (!connection) fail("connection-required");
    const selected = destination ?? (await personalNamespace());
    if (!selected) fail("registration-pending");
    const accepted = (await destinations()).find(
      (x) =>
        x.namespaceId === selected.namespaceId &&
        x.workspaceId === selected.workspaceId &&
        x.registrationGenesisDigest === selected.registrationGenesisDigest,
    );
    if (
      !accepted ||
      !(previousRevisionId === null
        ? accepted.canSubmit
        : accepted.canUpdateOwn)
    )
      fail("authority-denied");
    if (submissionId === undefined && previousRevisionId !== null)
      fail("invalid");
    if (previousRevisionId !== null) hexId(previousRevisionId);
    const binding = parseFilesKeyBinding({
      schema: "castalia.files-key-binding.v1",
      ownerMemberKey: owner,
      serviceId: config.serviceId,
      storageAccountId: connection.storageAccountId,
      namespaceId: accepted.namespaceId,
      workspaceId: accepted.workspaceId,
      submissionId: submissionId ?? randomId(),
      revisionId: randomId(),
    });
    const operationId = randomId(),
      record = {
        schema: "castalia.files-shipping-operation.v1",
        operationId,
        binding,
        sourceBinding: source.filesystem.binding,
        sourceRoot: source.root,
        sourcePath: source.path ?? null,
        registrationGenesisDigest: accepted.registrationGenesisDigest,
        previousRevisionId,
        connection,
        status: "Shipping",
        detail: "Preparing encrypted revision",
        updatedAt: new Date().toISOString(),
      };
    if (!globalThis.navigator?.locks?.request) fail("storage-unavailable");
    return navigator.locks.request(
      "castalia-files-shipping-operation-v1:" + operationId,
      { mode: "exclusive", ...(signal ? { signal } : {}) },
      async () => {
        check(signal);
        let persisted = false,
          key;
        try {
          const blob = await source.filesystem.createShipment(
            source.root,
            source.path,
            operationId,
          );
          check(signal);
          if (blob.size + 16 > connection.budgetBytes)
            fail(
              "quota",
              "Selected shipment exceeds the disclosed storage allowance",
            );
          const verified = await config.verifyShipment(blob);
          if (
            verified.root !== source.root ||
            verified.path !== (source.path ?? null)
          )
            fail("source-mismatch");
          key = crypto.getRandomValues(new Uint8Array(32));
          const body = { binding, key: base64url(key) },
            consent = await buildFilesConsent("wrap", body, origin);
          record.keyEnvelope = parseFilesKeyEnvelope(
            await provider.wrapFilesKey({ ...body, consent }),
          );
          assertSameBinding(binding, record.keyEnvelope.binding);
          check(signal);
          await currentOwner();
          const encrypted = await cryptoClient.encrypt(
            new Uint8Array(await blob.arrayBuffer()),
            key,
            binding,
            signal,
          );
          check(signal);
          record.nonce = encrypted.nonce;
          record.ciphertextSha256 = encrypted.ciphertextSha256;
          record.byteLength = encrypted.ciphertext.length;
          record.descriptorDigest = await sha256Hex(
            encoder.encode(
              canonicalJson({
                binding,
                keyEnvelope: record.keyEnvelope,
                nonce: record.nonce,
                ciphertextSha256: record.ciphertextSha256,
              }),
            ),
          );
          await save(record, new Blob([encrypted.ciphertext]));
          persisted = true;
          encrypted.ciphertext.fill(0);
          return await performLocked(record, signal);
        } finally {
          if (key?.byteLength) key.fill(0);
          if (!persisted)
            await source.filesystem
              .releaseShipment(operationId)
              .catch(() => {});
        }
      },
    );
  }
  async function resume(id, signal) {
    hexId(id);
    await connect();
    const record = await store.load(id);
    if (!record) fail("missing-operation");
    return perform(record, signal);
  }
  async function readRevision(value, submissionId, revisionId) {
    const envelope = parseFilesKeyEnvelope(value.keyEnvelope),
      binding = envelope.binding;
    if (
      binding.ownerMemberKey !== owner ||
      binding.serviceId !== config.serviceId ||
      binding.submissionId !== submissionId ||
      binding.revisionId !== revisionId
    )
      fail("owner-mismatch");
    const list = await connections(),
      p = parseStorageReceipt(value.storageReceipt.payload),
      conn = list.find(
        (x) =>
          x.gatewayId === p.gatewayId &&
          x.storageAccountId === binding.storageAccountId,
      );
    if (!conn) fail("connection-required");
    const acceptance = await verifyServiceEnvelope(
      value.acceptance,
      config.serviceId,
      parseIndexAcceptance,
    );
    const r = {
      operationId: acceptance.operationId,
      binding,
      connection: conn,
      keyEnvelope: envelope,
      nonce: value.nonce,
      storageReceipt: value.storageReceipt,
      ciphertextSha256: p.ciphertextSha256,
      byteLength: p.byteLength,
      registrationGenesisDigest: acceptance.registrationGenesisDigest,
      previousRevisionId: acceptance.previousRevisionId,
      descriptorDigest: await sha256Hex(
        encoder.encode(
          canonicalJson({
            binding,
            keyEnvelope: envelope,
            nonce: value.nonce,
            ciphertextSha256: p.ciphertextSha256,
          }),
        ),
      ),
    };
    matchStorage(
      await verifyServiceEnvelope(
        value.storageReceipt,
        conn.gatewayId,
        parseStorageReceipt,
      ),
      r,
    );
    await matchAcceptance(value.acceptance, r);
    return r;
  }
  async function listOwn() {
    await currentOwner();
    const values = await index("/v1/submissions");
    if (!Array.isArray(values) || values.length > 10000) fail("limit");
    return Promise.all(
      values.map(async (v) => {
        const p = await verifyServiceEnvelope(
          v.acceptance,
          config.serviceId,
          parseIndexAcceptance,
        );
        if (
          p.ownerMemberKey !== owner ||
          p.serviceId !== config.serviceId ||
          p.submissionId !== v.submissionId ||
          p.revisionId !== v.head ||
          p.namespaceId !== v.namespaceId ||
          p.workspaceId !== v.workspaceId ||
          typeof v.withdrawn !== "boolean"
        )
          fail("receipt-mismatch");
        return {
          ownerMemberKey: owner,
          submissionId: p.submissionId,
          revisionId: p.revisionId,
          namespaceId: p.namespaceId,
          workspaceId: p.workspaceId,
          withdrawn: v.withdrawn,
          receipt: v.acceptance,
        };
      }),
    );
  }
  async function retrieve(submissionId, revisionId, signal) {
    hexId(submissionId);
    await connect();
    let summary = (await listOwn()).find(
      (x) => x.submissionId === submissionId,
    );
    if (!summary) fail("not-found");
    revisionId = revisionId ?? summary.revisionId;
    hexId(revisionId);
    const value = await index(
        `/v1/submissions/${submissionId}/revisions/${revisionId}`,
        { signal },
      ),
      r = await readRevision(value, submissionId, revisionId),
      { blob, verified } = await freshRead(r, signal);
    await currentOwner();
    check(signal);
    return {
      blob,
      submission: { ...summary, revisionId, receipt: value.acceptance },
      sourceRoot: verified.root,
      sourcePath: verified.path,
    };
  }
  async function withdraw(submissionId) {
    hexId(submissionId);
    const own = (await listOwn()).find((x) => x.submissionId === submissionId);
    if (!own) fail("not-found");
    await index(`/v1/submissions/${submissionId}/withdraw`, {
      method: "POST",
      body: { expectedRevisionId: own.revisionId },
    });
  }
  return Object.freeze({
    connect,
    personalNamespace,
    saveConnection,
    acceptRegistration,
    destinations,
    listOwn,
    ship,
    resume,
    retrieve,
    withdraw,
    async operations() {
      await currentOwner();
      return (await store.operations(owner, config.serviceId)).map(
        publicRecord,
      );
    },
    observe(listener) {
      check();
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    currentStatus(record, root) {
      return ["Shipping", "Shipped"].includes(record.status) &&
        record.sourceRoot !== root
        ? "Local changes"
        : record.status;
    },
    dispose() {
      if (closed) return;
      closed = true;
      for (const r of requests) r.abort();
      requests.clear();
      cryptoClient.dispose();
      listeners.clear();
      sessions.clear();
    },
  });
}
