// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  exact,
  hex32,
  entityKey,
  registrationKey,
  workspaceKey,
  parseAddress,
  RegistrationError,
} from "./address.mjs";
import { atomic } from "./database.mjs";
import { parseWorkspaceCatalog } from "./catalog-format.mjs";
import {
  verifyRegistrationChain,
  verifiedRegistrationState,
  parseSignedRegistration,
  PERSON_CLASS,
  ORGANIZATION_CLASS,
} from "./registration.mjs";
const RECORD = "castalia.filesystem-registration-record.v1";
const ROW = "castalia.filesystem-workspace.v1";
const INDEX = "castalia.reviewed-namespace-index.v1";
export function parseWorkspaceRow(value) {
  exact(
    value,
    ["schema", "address", "entityRef", "registrationGenesisDigest", "catalog"],
    "workspace row",
  );
  if (value.schema !== ROW)
    throw new RegistrationError("invalid", "Unsupported workspace row");
  entityKey(value.entityRef);
  return {
    schema: ROW,
    address: parseAddress(value.address),
    entityRef: value.entityRef,
    registrationGenesisDigest: hex32(value.registrationGenesisDigest),
    catalog: parseWorkspaceCatalog(value.catalog),
  };
}
function recordFrom(state) {
  return {
    schema: RECORD,
    chain: state.chain,
    membershipCredential: state.membershipCredential,
    manifestDigest: state.manifestDigest,
    registrationGenesisDigest: state.genesisDigest,
  };
}
function parseRecord(value) {
  exact(
    value,
    [
      "schema",
      "chain",
      "membershipCredential",
      "manifestDigest",
      "registrationGenesisDigest",
    ],
    "registration record",
  );
  if (
    value.schema !== RECORD ||
    !Array.isArray(value.chain) ||
    value.chain.length < 1 ||
    value.chain.length > 256
  )
    throw new RegistrationError("invalid", "Unsupported registration record");
  return {
    ...value,
    chain: value.chain.map(parseSignedRegistration),
    manifestDigest: hex32(value.manifestDigest),
    registrationGenesisDigest: hex32(value.registrationGenesisDigest),
  };
}
function readMany(store, keys, callback, abort) {
  const results = new Array(keys.length);
  let remaining = keys.length;
  keys.forEach((key, index) => {
    const request = store.get(key);
    request.addEventListener(
      "success",
      () => {
        results[index] = request.result;
        if (--remaining === 0) {
          try {
            callback(results);
          } catch (error) {
            abort(error);
          }
        }
      },
      { once: true },
    );
  });
}
function rowFrom(state, workspaceId, catalog) {
  return parseWorkspaceRow({
    schema: ROW,
    address: { namespaceId: state.manifest.namespaceId, workspaceId },
    entityRef: state.manifest.entityRef,
    registrationGenesisDigest: state.genesisDigest,
    catalog,
  });
}
function sameBinding(a, b) {
  return (
    a.entityRef === b.entityRef &&
    a.namespaceId === b.namespaceId &&
    a.registrationGenesisDigest === b.registrationGenesisDigest
  );
}
export function parseReviewedManifestIndex(value) {
  exact(value, ["schema", "entries"], "reviewed manifest index");
  if (
    value.schema !== INDEX ||
    !Array.isArray(value.entries) ||
    value.entries.length > 4096
  )
    throw new RegistrationError("invalid", "Invalid reviewed manifest index");
  const paths = new Set(),
    namespaces = new Set();
  const entries = value.entries.map((entry) => {
    exact(
      entry,
      [
        "entityRef",
        "namespaceId",
        "registrationGenesisDigest",
        "canonicalPath",
      ],
      "reviewed mount entry",
    );
    entityKey(entry.entityRef);
    hex32(entry.namespaceId);
    hex32(entry.registrationGenesisDigest);
    if (
      typeof entry.canonicalPath !== "string" ||
      !/^\/(Person|Organization)\/[A-Za-z0-9][A-Za-z0-9._-]{0,127}\/$/u.test(
        entry.canonicalPath,
      ) ||
      paths.has(entry.canonicalPath) ||
      namespaces.has(entry.namespaceId)
    )
      throw new RegistrationError(
        "invalid",
        "Invalid or duplicate canonical mount",
      );
    paths.add(entry.canonicalPath);
    namespaces.add(entry.namespaceId);
    return { ...entry };
  });
  return { schema: INDEX, entries };
}
function sameMount(value, expected) {
  const parsed = parseReviewedManifestIndex({ schema: INDEX, entries: [value] })
    .entries[0];
  return (
    sameBinding(parsed, expected) &&
    parsed.canonicalPath === expected.canonicalPath
  );
}
function approvedEntry(state, index) {
  const entries = parseReviewedManifestIndex(index).entries;
  const expected = {
    entityRef: state.manifest.entityRef,
    namespaceId: state.manifest.namespaceId,
    registrationGenesisDigest: state.genesisDigest,
  };
  const entry = entries.find((candidate) => sameBinding(candidate, expected));
  const prefix =
    state.manifest.entityClass === PERSON_CLASS
      ? "/Person/"
      : state.manifest.entityClass === ORGANIZATION_CLASS
        ? "/Organization/"
        : null;
  if (!entry || !prefix || !entry.canonicalPath.startsWith(prefix))
    throw new RegistrationError(
      "unauthorized",
      "Namespace is not in the reviewed manifest index",
    );
  return entry;
}
function assertEntityBinding(value, state) {
  exact(
    value,
    ["namespaceId", "registrationGenesisDigest"],
    "entity namespace binding",
  );
  if (
    value.namespaceId !== state.manifest.namespaceId ||
    value.registrationGenesisDigest !== state.genesisDigest
  )
    throw new RegistrationError(
      "invalid",
      "Entity uniqueness binding is missing",
    );
}
function assertCurrent(value, state) {
  if (value === undefined)
    throw new RegistrationError("conflict", "Registration is missing");
  const record = parseRecord(value);
  if (
    record.manifestDigest !== state.manifestDigest ||
    record.registrationGenesisDigest !== state.genesisDigest ||
    JSON.stringify(record.chain) !== JSON.stringify(state.chain)
  )
    throw new RegistrationError("conflict", "Registration changed");
  return record;
}
/** Caller supplies a trusted, reviewed index. A persisted proposal is never such an index. */
export async function loadRegistration(db, namespaceId, { trustPolicy }) {
  const raw = await atomic(db, "readonly", (store, done, abort) =>
    readMany(
      store,
      [registrationKey(namespaceId)],
      ([value]) => done(value),
      abort,
    ),
  );
  if (raw === undefined) return null;
  const record = parseRecord(raw);
  const registration = await verifyRegistrationChain(record.chain, {
    membershipCredential: record.membershipCredential,
    trustPolicy,
  });
  if (
    registration.manifest.namespaceId !== namespaceId ||
    registration.manifestDigest !== record.manifestDigest ||
    registration.genesisDigest !== record.registrationGenesisDigest
  )
    throw new RegistrationError(
      "invalid",
      "Stored registration binding mismatch",
    );
  return registration;
}
/** Genesis + entity uniqueness + namespace/controller chain + initial catalog commit atomically. */
export async function publishRegistration(
  db,
  registration,
  { catalog, reviewedIndex } = {},
) {
  const state = verifiedRegistrationState(registration),
    manifest = state.manifest;
  const genesis = manifest.revision === 0;
  const row = genesis
    ? rowFrom(state, manifest.initialWorkspaceId, catalog)
    : null;
  if (!genesis && catalog !== undefined)
    throw new RegistrationError(
      "invalid",
      "Updates cannot replace a workspace catalog",
    );
  const approved =
    reviewedIndex === undefined ? null : approvedEntry(state, reviewedIndex);
  const keys = [
    registrationKey(manifest.namespaceId),
    entityKey(manifest.entityRef),
  ];
  if (row) keys.push(workspaceKey(row.address));
  if (approved) keys.push(["canonical-mount-v1", approved.canonicalPath]);
  return atomic(db, "readwrite", (store, done, abort) =>
    readMany(
      store,
      keys,
      (values) => {
        const [current, entity] = values;
        const existingRecord =
          current === undefined ? null : parseRecord(current);
        const identical =
          existingRecord !== null &&
          existingRecord.manifestDigest === state.manifestDigest &&
          existingRecord.registrationGenesisDigest === state.genesisDigest &&
          JSON.stringify(existingRecord.chain) === JSON.stringify(state.chain);
        if (identical) {
          assertCurrent(current, state);
          assertEntityBinding(entity, state);
          if (row) {
            const existingRow = parseWorkspaceRow(values[2]);
            if (
              JSON.stringify(existingRow.address) !==
                JSON.stringify(row.address) ||
              existingRow.entityRef !== row.entityRef ||
              existingRow.registrationGenesisDigest !==
                row.registrationGenesisDigest
            )
              throw new RegistrationError(
                "invalid",
                "Initial workspace binding changed",
              );
          }
        } else if (genesis) {
          if (
            current !== undefined ||
            entity !== undefined ||
            values[2] !== undefined
          )
            throw new RegistrationError(
              "conflict",
              "Entity or namespace is already registered",
            );
        } else {
          if (!existingRecord)
            throw new RegistrationError(
              "conflict",
              "Cannot update an unregistered namespace",
            );
          if (
            existingRecord.manifestDigest !== manifest.previousManifestDigest ||
            existingRecord.registrationGenesisDigest !== state.genesisDigest ||
            existingRecord.chain.length !== manifest.revision ||
            JSON.stringify(existingRecord.chain) !==
              JSON.stringify(state.chain.slice(0, -1))
          )
            throw new RegistrationError(
              "conflict",
              "Registration update lost compare-and-swap",
            );
          assertEntityBinding(entity, state);
        }
        if (approved) {
          const existing = values.at(-1);
          if (existing !== undefined && !sameMount(existing, approved))
            throw new RegistrationError(
              "conflict",
              "Canonical path is already bound",
            );
          store.put(approved, ["canonical-mount-v1", approved.canonicalPath]);
        }
        if (!identical)
          store.put(recordFrom(state), registrationKey(manifest.namespaceId));
        if (genesis && !identical) {
          store.put(
            {
              namespaceId: manifest.namespaceId,
              registrationGenesisDigest: state.genesisDigest,
            },
            entityKey(manifest.entityRef),
          );
          store.put(row, workspaceKey(row.address));
        }
        done(registration);
      },
      abort,
    ),
  );
}
/** Add a child workspace; never allocate another organization namespace. */
export async function publishWorkspace(
  db,
  { registration, workspaceId, catalog },
) {
  const state = verifiedRegistrationState(registration),
    row = rowFrom(state, workspaceId, catalog);
  return atomic(db, "readwrite", (store, done, abort) =>
    readMany(
      store,
      [registrationKey(row.address.namespaceId), workspaceKey(row.address)],
      ([current, existing]) => {
        assertCurrent(current, state);
        if (existing !== undefined)
          throw new RegistrationError("conflict", "Workspace already exists");
        store.put(row, workspaceKey(row.address));
        done(row);
      },
      abort,
    ),
  );
}
/** Explicit acceptance of an already verified local proposal against a reviewed index. */
export async function acceptReviewedManifest(db, registration, reviewedIndex) {
  const state = verifiedRegistrationState(registration),
    entry = approvedEntry(state, reviewedIndex),
    key = ["canonical-mount-v1", entry.canonicalPath];
  return atomic(db, "readwrite", (store, done, abort) =>
    readMany(
      store,
      [registrationKey(entry.namespaceId), key],
      ([current, existing]) => {
        assertCurrent(current, state);
        if (existing !== undefined && !sameMount(existing, entry))
          throw new RegistrationError(
            "conflict",
            "Canonical path is already bound",
          );
        store.put(entry, key);
        done(entry);
      },
      abort,
    ),
  );
}
export async function assertAcceptedNamespace(
  db,
  binding,
  reviewedIndex,
  { trustPolicy },
) {
  exact(
    binding,
    ["namespaceId", "entityRef", "registrationGenesisDigest"],
    "namespace binding",
  );
  hex32(binding.namespaceId);
  entityKey(binding.entityRef);
  hex32(binding.registrationGenesisDigest);
  const registration = await loadRegistration(db, binding.namespaceId, {
    trustPolicy,
  });
  if (!registration)
    throw new RegistrationError("unauthorized", "No local registration");
  const state = verifiedRegistrationState(registration),
    entry = approvedEntry(state, reviewedIndex);
  if (!sameBinding(binding, entry))
    throw new RegistrationError("unauthorized", "Namespace binding mismatch");
  await atomic(db, "readonly", (store, done, abort) =>
    readMany(
      store,
      [
        registrationKey(binding.namespaceId),
        ["canonical-mount-v1", entry.canonicalPath],
      ],
      ([current, mount]) => {
        assertCurrent(current, state);
        if (!mount || !sameMount(mount, entry))
          throw new RegistrationError(
            "unauthorized",
            "Reviewed mount has not been accepted",
          );
        done();
      },
      abort,
    ),
  );
  return registration;
}

/** Publication as an accepted mount always requires an explicit reviewed index. */
export function publishAcceptedRegistration(db, registration, options) {
  if (!options || options.reviewedIndex === undefined)
    return Promise.reject(
      new RegistrationError(
        "unauthorized",
        "A reviewed manifest index is required",
      ),
    );
  return publishRegistration(db, registration, options);
}
/** Only configured, explicitly accepted local mounts; no name-to-ID discovery. */
export async function listAcceptedMounts(db, reviewedIndex, { trustPolicy }) {
  const index = parseReviewedManifestIndex(reviewedIndex);
  if (index.entries.length === 0) return [];
  const persisted = await atomic(db, "readonly", (store, done, abort) =>
    readMany(
      store,
      index.entries.map((entry) => ["canonical-mount-v1", entry.canonicalPath]),
      done,
      abort,
    ),
  );
  const mounts = [];
  for (let i = 0; i < index.entries.length; i++) {
    if (persisted[i] === undefined) continue;
    const entry = index.entries[i];
    const registration = await assertAcceptedNamespace(
      db,
      {
        namespaceId: entry.namespaceId,
        entityRef: entry.entityRef,
        registrationGenesisDigest: entry.registrationGenesisDigest,
      },
      index,
      { trustPolicy },
    );
    mounts.push({ ...entry, registration });
  }
  return mounts;
}
export async function resolveMount(
  db,
  canonicalPath,
  reviewedIndex,
  { trustPolicy },
) {
  const index = parseReviewedManifestIndex(reviewedIndex);
  const entry = index.entries.find(
    (value) => value.canonicalPath === canonicalPath,
  );
  if (!entry) return null;
  const mounts = await listAcceptedMounts(
    db,
    { schema: INDEX, entries: [entry] },
    { trustPolicy },
  );
  return mounts[0] ?? null;
}

/** Reload explicit local acceptance records only; never infer review from proposals. */
export async function loadLocalReviewedIndex(db) {
  return atomic(db, "readonly", (store, done, abort) => {
    const request = store.openCursor();
    const entries = [];
    let scanned = 0;
    const finish = () =>
      done(parseReviewedManifestIndex({ schema: INDEX, entries }));
    request.addEventListener("success", () => {
      try {
        const cursor = request.result;
        if (!cursor) {
          finish();
          return;
        }
        if (++scanned > 8192)
          throw new RegistrationError(
            "limit",
            "Accepted mount scan limit exceeded",
          );
        const key = cursor.key;
        if (Array.isArray(key) && typeof key[0] === "string") {
          // Compound keys sort by their first component; stop past this prefix.
          if (key[0] > "canonical-mount-v1") {
            finish();
            return;
          }
          if (key[0] === "canonical-mount-v1") {
            if (key.length !== 2 || typeof key[1] !== "string")
              throw new RegistrationError(
                "invalid",
                "Invalid stored mount key",
              );
            const entry = parseReviewedManifestIndex({
              schema: INDEX,
              entries: [cursor.value],
            }).entries[0];
            if (entry.canonicalPath !== key[1])
              throw new RegistrationError(
                "invalid",
                "Stored mount path mismatch",
              );
            if (entries.length >= 4096)
              throw new RegistrationError(
                "limit",
                "Accepted mount count exceeded",
              );
            entries.push(entry);
          }
        }
        cursor.continue();
      } catch (error) {
        abort(error);
      }
    });
  });
}
