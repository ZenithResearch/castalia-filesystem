# Browser namespace registration v1

The `@castalia/filesystem/registration` entry is dependency-free ESM with TypeScript declarations. It does not open a database, request a wallet login, create keys, issue membership, or grant file access. `@castalia/filesystem/browser` supplies local persistence. See [identity sources](IDENTITY-MAPPING.md) before selecting trust policies or canonical aliases.

## Durable manifest and fresh consent

`createRegistrationManifest` takes `entityClass`, `creatorMemberKey`, `genesisNonce`, `initialWorkspaceId` and `displayName`. The class is the canonical Person or Organization URI. Person genesis uses the all-zero nonce, producing one deterministic personal identity per creator. Organization genesis requires a fresh random 32-byte nonzero nonce, so one member can create distinct organizations. Nonces are public; custody continues to use the existing Member Key.

Entity derivation is SHA-256 of UTF-8 `castalia/entity-genesis/v1\0` followed by fixed-order JSON `{entityClass,creatorMemberKey,genesisNonce}`. The opaque reference is `urn:castalia:entity:<digest>`. Namespace ID is SHA-256 of UTF-8 `castalia/entity-namespace/v1\0` followed by that reference. These are new local entity/namespace bindings, not invented universe/federation genesis records. Initial workspace IDs are separately supplied random 32-byte values; a snapshot root is not a workspace ID.

The manifest has exactly these fields, in this canonical serialization order:

```text
schema, entityRef, entityClass, creatorMemberKey, genesisNonce,
namespaceId, initialWorkspaceId, controllerMemberKey, displayName,
revision, previousManifestDigest
```

Schema is `castalia.namespace-registration.v1`. Revision zero has null previous digest and creator as initial controller. A later revision preserves the first seven identity fields, increments the revision by one and binds the exact previous manifest digest. The prior controller signs the update, including any new controller. Names are bounded, trimmed NFC strings without control characters; names never identify or claim another entity.

`registrationSigningBytes(manifest)` returns UTF-8 `castalia/namespace-registration/v1\0` followed by the parser's fixed-order JSON. `registrationManifestDigest` is SHA-256 of those bytes. The signature envelope has schema `castalia.signed-namespace-registration.v1`, `manifest`, `signerMemberKey`, `signatureSuite: "Ed25519"`, and a canonical unpadded base64url 64-byte `signature`. `verifySignedRegistration` checks signature and ID derivation only; `verifyRegistrationChain` additionally requires verified Castalia base-v3 creation membership and checks every controller transition. Chains are bounded at 256 revisions.

A generic compatible provider exposes:

```ts
requestRegistration({ manifest, consent }): Promise<SignedRegistrationManifestV1>
```

Consent has exactly `requestId`, `origin`, `audience`, `nonce`, `issuedAtMs`, `expiresAtMs`, and `manifestDigest`. Both origin and audience equal the actual requesting browser origin for this local flow. The nonce is 32-byte hex, the request ID is 16–128 ASCII letters/digits/underscore/hyphen, and the maximum lifetime is 120 seconds. `validateRegistrationRequest` checks syntax, derivation, digest and the caller-supplied actual origin/time context. The wallet owns explicit confirmation, single-use request/nonce tracking, revocation, lock/disposal and rechecking these conditions after asynchronous work. The contract does not infer those facts from request JSON. Existing Auth login and Work/Arena signing bytes stay unchanged.

Expiry applies to consent before signing, not to a correctly signed durable registration manifest. Profiles and `.castaway` membership proofs do not become signing authority. Genesis eligibility uses the existing pinned v3 issuer policy; the fixture issuer in tests is never implicitly trusted.

## Local atomic publication

The database remains `castalia-browser-filesystem`, version 2, store `catalog`. The legacy `workspace` string key remains unchanged. New keys are:

| Key                                          | Value                                                                                                                            |
| -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `["registration-v1", namespaceId]`           | Strict registration record with complete signed chain, creation membership, current manifest digest and immutable genesis digest |
| `["entity-namespace-v1", entityRef]`         | Namespace/genesis uniqueness binding                                                                                             |
| `["workspace-v1", namespaceId, workspaceId]` | Strict row with address, entity reference, immutable genesis digest and nested existing-v1 catalog                               |
| `["canonical-mount-v1", canonicalPath]`      | Explicitly accepted reviewed index entry                                                                                         |

`verifyRegistrationChain` returns an opaque in-process verification token. `publishRegistration` accepts that token and an initial catalog for genesis. It writes all new records in one transaction, resolves only on transaction completion, and rejects a differing existing entity, namespace or initial workspace. An identical signed submission is idempotent, may omit the initial catalog, and never resets a workspace catalog; a genuinely new genesis still requires a catalog. Updates compare the preceding digest, genesis and revision count inside the same transaction; they cannot replace a workspace catalog. A failed write or abort publishes none of the records. Cryptographic verification occurs before the transaction; compare-and-swap catches changes during that work.

`listWorkspaceRows` enumerates at most 1024 strict child rows for one exact namespace/entity/genesis binding, without a legacy fallback.

`publishWorkspace` creates only a child workspace of the token's already registered namespace and compares the full current registration digest inside its transaction. It rejects an existing workspace and preserves entity/genesis bindings. Ordinary local catalog/head writes retain existing snapshot validation and per-workspace locking; there is no new signed file-head protocol or remote authorization claim.

`publishAcceptedRegistration` requires the explicit reviewed index, while `publishRegistration` without it stores only a local proposal. `listAcceptedMounts` and `resolveMount` return only exact configured paths that have been locally accepted and whose stored chain verifies; missing canonical mappings return no mount, never a name-based fallback.

`loadRegistration` re-verifies the stored chain under an explicitly supplied issuer policy. Unknown records and corrupted signatures fail closed rather than becoming recovery candidates. The registration provider and stored format are separate from signing recovery and from `.castaway`.

## Reviewed mount acceptance

The reviewed index is trusted application configuration supplied explicitly by its operator, not a value inferred from local proposals or downloaded without review. It has schema `castalia.reviewed-namespace-index.v1` and entries containing `entityRef`, `namespaceId`, `registrationGenesisDigest`, and `canonicalPath`. Paths are `/Person/<segment>/` or `/Organization/<segment>/`, must match the manifest class, and are unique. A name match is insufficient.

`acceptReviewedManifest` compares the verified current registration head inside the acceptance transaction. `assertAcceptedNamespace` requires both the exact supplied reviewed index binding and its locally accepted mount record; it also checks that the registration has not changed during signature verification. Each namespace has one locally accepted canonical path. Explicit acceptance of a different reviewed path for the same entity, namespace and genesis atomically removes the prior path and writes the replacement; physical storage IDs, workspace catalogs and signed registration bytes stay unchanged. A failed write rolls back the path change. The path must still match the signed entity class. A different namespace cannot replace an occupied canonical path. An application alias to `/` does not change the canonical identity or synchronize origins. `loadLocalReviewedIndex` reloads only strict `canonical-mount-v1` records written by explicit acceptance, with bounded cursor traversal. It never promotes ordinary registration proposals. These records are local user acceptance, not independently authenticated registry-operator policy: a production application claiming a canonical organization such as Zenith must also pin the authoritative entry in its configuration. Missing pins remain pending. Workers can reload the accepted records from IndexedDB and reverify with `assertAcceptedNamespace`; no localStorage or name fallback is involved.

A live registry, signed operator-index distribution and external existing-entity controller evidence remain outside this local candidate; no fallback invents them.

## Compatibility and evidence

The checked-in synthetic vector freezes manifest bytes, derived IDs and digest. The existing v3 membership fixture freezes its prior framed transcript and signature. Node tests cover valid rotation, wrong signer, malformed IDs, unknown fields, consent deadline/origin/body binding, duplicate roots, atomic abort/quota failures, stale-head publication, alias collision and legacy-key preservation. These unit tests do not replace actual browser acceptance, consumer bundling, or production qualification.

AGPL attribution and unresolved inherited-source permission questions remain as recorded in the identity mapping. Consumer policy acceptance is separate; a passing source test creates no permission grant or registry publication.
