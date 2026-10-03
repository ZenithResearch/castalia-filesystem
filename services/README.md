# Private Files index and Sia gateway

These are separate Node **24.18.0** processes. The Castalia application index is the authority for accepted registrations, submission heads and grants. A user-operated gateway holds its own S3/admin credentials and transports only ciphertext. Neither service has a Files decryption key. The packages use Node built-ins only; `package-lock.json` records the empty external dependency graph. Existing Wallet/Auth, membership v3, registration and local filesystem formats are unchanged.

This is an implementation candidate, **not a deployed service or funded Sia acceptance result**. Tests use disposable member identities, databases and controlled S3 responses. Review permission/licensing gates and real operator setup remain separate.

## Run

Run from the source checkout (the services import its shared browser contract modules):

```sh
cd services
node --version # v24.18.0
npm ci --ignore-scripts
npm test
node src/cli.mjs index /private/operator/index.json
node src/cli.mjs gateway /private/operator/gateway.json
```

The JSON configuration and Ed25519 PEM signing-key file must be private regular files (0600), and each database directory must be private (0700). The CLI sets umask 077. Use separate persistent directories and signing keys for each process. Signing keys identify services, not members; `serviceId`/`gatewayId` are their raw Ed25519 public keys in lowercase hex. Preserve these pinned keys across restart. A service-key change requires an explicit client trust update, never silent endpoint trust-on-first-use.

Both configurations include `databasePath`, `signingKeyFile`, `allowedOrigins`, `host` and `port`. Serve behind HTTPS; direct loopback HTTP is only for local development. Origins are exact allowlisted origins, and each 15-minute bearer session is bound to one owner Member Key and origin. Do not persist browser bearer tokens. The challenge uses the existing eight-field Auth transcript, expires within 120 seconds and can be consumed once. Shutdown/disposal can revoke the session using DELETE `/v1/auth/session`.

Index configuration additionally contains:

- `trustPolicy`: existing Castalia base-v3 membership roots, supplied by the operator from an authoritative source.
- `gateways`: records `{gatewayId, storageAccountId, gatewayUrl, allowedMembers}`. Each configured gateway/account must explicitly permit the uploader's Member Key; accepted namespace membership does not authorize spending someone else's storage account.
- Optional `canonicalBindings`: reviewed records `{alias, namespaceId, registrationGenesisDigest}`. Leave empty until the real organization has been registered and its binding reviewed. An absent `zenith` binding remains pending. Labels and v4 community scopes never create this binding.

Gateway configuration additionally contains `indexServiceIds`, `storageAccountId`, `allowedMembers`, `providerName`, `termsUrl`, `maxAccountBytes` and `s3d`. Its fixed `s3d` record contains `endpoint`, `adminEndpoint`, `accessKey`, `secretKey`, `adminPassword`, `bucket`, optional `region` and `s3dRevision`. Do not put this configuration in Web/Zenith code, browser storage, index connections, or repository examples. Browser connection discovery stores only public endpoint/identity/provider metadata and an explicit byte budget.

## Official s3d contract and operator prerequisites

The only supported release is official [SiaFoundation/s3d v0.2.0](https://github.com/SiaFoundation/s3d/tree/e468d007cfc9eefa083d09b5a858ba294f64f6cf), exact revision `e468d007cfc9eefa083d09b5a858ba294f64f6cf`. The gateway requires this configured revision. There is no remote version-attestation endpoint: qualification must independently verify the installed binary/container revision before trusting receipts. There is no fork, internal crate, Dregg integration or fallback.

The operator must register this s3d instance with the official Sia indexer, fund/authorize its existing provider allowance, create a private bucket, enable bucket versioning, and exclusively manage that account/bucket through this gateway. Bucket policies permitting public read are incompatible. Protect the S3 and admin endpoints from browsers and third parties. The gateway does not create accounts, accept payment, change bucket policy, configure allowance or grant public read. Pay-per-push is not implemented.

The adapter implements ordinary AWS Signature V4 and these real release endpoints:

- S3 `GET ?versioning`, `POST object?uploads`, `PUT object?uploadId&partNumber`, `POST object?uploadId`, `GET ?uploads&prefix`, `HEAD object`, and `GET object?versionId`.
- Admin `POST /objects/flush` then `GET /stats/uploads`.

The release's [s3/admin.go](https://github.com/SiaFoundation/s3d/blob/e468d007cfc9eefa083d09b5a858ba294f64f6cf/s3/admin.go) exposes `unpinnedObjects` even though its OpenAPI schema omits that field. Both `pendingObjects` and `unpinnedObjects` must be present integers and equal zero. Flush alone does not qualify storage. The gateway serializes its upload mutations, then reads the exact immutable object version freshly and verifies its complete ciphertext SHA256 and length before signing a receipt. The browser independently verifies the receipt, decrypts and verifies the recovered archive. Versioning must already be enabled; null or mismatched versions fail closed.

## Atomicity, authority and recovery

SQLite uses WAL, synchronous FULL, foreign keys and BEGIN IMMEDIATE for authority/index mutations. A unique personal creator index permits exactly one personal namespace. Creation verifies the existing signed registration chain and base-v3 eligibility; the creator is its initial controller. Existing registration changes must extend the exact accepted chain. A public application index does not become a namespace controller.

An upload intent binds owner, accepted registration genesis, namespace/workspace/submission/revision, expected previous head, encrypted object digest/size, gateway account and expiry. The index signs it; the gateway requires a matching owner session and its own explicit account allowlist. Intents expire after 24 hours. New ciphertext is never admitted with an expired intent.

The opaque operation ID and multipart journal survive restart. Repeated identical parts are idempotent; different bytes for an existing part conflict. A lost initiation response is recovered only from a unique multipart listing for the exact opaque object key. Zero/multiple matches require operator reconciliation; they never produce a successful receipt. A lost completion response is recovered via exact object metadata, version and a full fresh integrity read. Incomplete uploads, stored-but-unaccepted ciphertext and failed index CAS remain explicit recoverable/orphan records; this implementation never garbage-collects them automatically.

One index transaction rechecks current namespace/controller/grant authority, compares the expected submission head, inserts the immutable revision, updates the current head and records the idempotent acceptance. It does not mutate an S3 head. Conflicting submissions retain their old head and can query operation state after an uncertain response. Different authenticated users cannot read each other's connection records, submissions or ciphertext, including namespace controllers.

`descriptorDigest` is SHA256 of canonical JSON `{binding,keyEnvelope,nonce,ciphertextSha256}`. It binds the wrapped key and payload nonce independently of ciphertext hashing and avoids a circular revision digest. Existing key-wrap recovery remains Wallet-owned. Full encrypted archive content, paths and local snapshot roots remain outside plaintext index data.

For organizations, current controllers may issue only `submit`, `update-own` and `withdraw-own` grants with workspace scope, byte bound and expiry (maximum 30 days). Controller changes invalidate grants tied to the old controller/registration revision. Admission is checked again at commit. Removing admission or account access never removes an existing uploader's authenticated read/recovery and withdrawal rights. Withdrawal tombstones placement and leaves immutable receipts/content available to that uploader. Sharing, public reads, cross-user decryption, remote deletion and automatic retention reclamation remain absent.

## HTTP surface

All endpoints require an exact allowed `Origin`. Except config and Auth bootstrap, they also require `Authorization: Bearer <session>`.

| Common | Body / response |
| --- | --- |
| GET `/v1/config` | Pinned service identity; gateway also exposes public account/provider metadata |
| POST `/v1/auth/challenge` | `{memberKey}` → existing Auth challenge |
| POST `/v1/auth/session` | `{presentation}` → `{token,memberKey,expiresAt}` |
| DELETE `/v1/auth/session` | Revoke current bearer |

| Index | Body / response |
| --- | --- |
| GET `/v1/namespaces/personal`, `/v1/namespaces` | Registration chain/credential and signed namespace acceptance |
| GET `/v1/destinations` | Personal plus explicit pending/registered Zenith binding |
| POST `/v1/registrations/accept` | `{chain,membershipCredential,expectedManifestDigest}` |
| GET/PUT `/v1/connections` | Owner's public gateway descriptors only |
| POST `/v1/upload-intents` | `{operationId,binding,expectedRevisionId,ciphertextSha256,byteLength,gatewayId}` |
| POST `/v1/submissions/commit` | `{operationId,storageReceipt,descriptorDigest,keyEnvelope,nonce}` |
| GET `/v1/operations/:operationId` | Intent and nullable accepted receipt |
| GET `/v1/submissions` | Owner's heads, recovery metadata and tombstone state |
| GET `/v1/submissions/:id/history` | Owner's immutable revisions |
| GET `/v1/submissions/:id/revisions/:revisionId` | One owner's revision, wrapped key, nonce and receipts |
| POST `/v1/submissions/:id/withdraw` | `{expectedRevisionId}` |
| POST `/v1/grants`, `/v1/grants/revoke` | Current controller only |

| Gateway | Body / response |
| --- | --- |
| POST `/v1/uploads` | `{intent}` signed by a pinned index |
| GET `/v1/uploads/:operationId` | Durable part journal and nullable storage receipt |
| PUT `/v1/uploads/:operationId/parts/:number` | Raw ciphertext, 8 MiB except final part |
| POST `/v1/uploads/:operationId/complete` | `{}` → verified storage receipt |
| GET `/v1/objects/:operationId` | Fresh immutable-version ciphertext, uploader only |

No endpoint proxies a caller-supplied S3 URL. HTTP errors expose stable error codes, not credentials or internal exception strings. Content filenames and recovery secrets must never appear in logs.

## Remaining qualification

Run `npm test` here and the shared browser contract tests. Tests establish implementation behavior using mock Sia transport and actual loopback HTTP; they do not establish provider durability or production qualification. Before release, inspect the exact s3d runtime, private/versioned bucket policy, provider allowance and account authority; run funded upload/flush/pin/fresh-read, quota/host outage and interruption tests against isolated operator infrastructure. Qualify service DB backup/restore, signing-key custody, TLS/origin config, rate limiting, monitoring and a restore drill. A fresh device trusts the configured index key for currentness; signed historical receipts alone cannot prove the index has not rolled back. Keep independent index backups/checkpoints and disclose this trust boundary.

### Verified operator launcher and service packages

Download the matching official ZIP from the pinned release to an operator-controlled path. `s3d-release.json` records the official GitHub release API's asset SHA256 and size for supported macOS/Linux x64/arm64 distributions, observed 2026-10-03. The launcher verifies those pinned bytes **before** extraction or executable use, extracts only the `s3d` entry into a private directory, and checks its embedded version/commit before an explicitly requested run:

```sh
node services/scripts/s3d-launcher.mjs /operator/downloads/s3d_linux_amd64.zip --verify-only
node services/scripts/s3d-launcher.mjs /operator/downloads/s3d_linux_amd64.zip --run
```

`--verify-only` performs no s3d execution or network action. `--run` is an operator action that starts s3d and can use that operator's configured storage account. The package does not download or launch s3d automatically. It uses the system `/usr/bin/unzip` only after the archive checksum succeeds; no release executable is trusted from an arbitrary PATH. The checksum pins the release distribution, while gateway receipts still rely on an honest operator connecting the configured endpoints to that verified process.

Build a complete, separate source operator package using `node services/scripts/build-package.mjs /new/output/path`. Its manifest records every included file, SHA256, source revision/dirty state, Node and s3d pins. The package contains its required shared registration/Auth/receipt modules and synthetic tests; it has no Rust/WASM/browser ZIP runtime dependency. CI builds the package twice, compares every byte and runs the service tests from the packaged output. A dirty build is explicitly labeled and is not a final release candidate.

The grants endpoint returns an index-signed `castalia.files-admission-grant.v1` acceptance that binds the current registration digest, genesis, controller, grantee, workspace, actions, bytes and expiry. It attests a controller-authenticated request accepted by this index. It is **not** a transferable wallet-signed capability and gives no forward delegation. A future organization grant UI must require an explicit controller action; Phase 1 exposes no grant form. Neither an Auth login nor this record reveals a decryption key.


Both Web and Zenith deployments must preconfigure the same trusted gateway origin and key in their explicit `connect-src`/Files configuration. Authenticated index discovery restores an owner's account/allowance metadata only within that configured endpoint. An index URL/key alone is a pending setup, not authority to contact arbitrary discovered URLs. This first release does not add a portable connection-attestation protocol.

The full-source service test run includes `browser-shipping.test.mjs`, which uses the existing root `fake-indexeddb` development dependency and the actual shared coordinator with a controlled worker/provider. Run root `npm ci --ignore-scripts --no-audit --no-fund` first for that integration test. The separate operator package excludes this browser integration test (recorded explicitly in its manifest); all dependency-free server tests run again from packaged files. Existing source-permission and release qualification boundaries still apply to the reused registration verifier; packaging does not grant new rights.

`backupDatabase(db, newPrivatePath)` uses SQLite's transaction-consistent online backup API, creates its output privately without overwriting an existing file, and syncs the file and parent directory. Restore only a completed snapshot into a private directory; do not copy a live main SQLite file without its WAL. Keep the index and gateway snapshots plus separately protected service signing keys and s3d recovery/database material. The index snapshot preserves accepted heads/receipts; the gateway snapshot preserves upload/version journals. Wallet recovery restores decryption keys separately.

Production gateway configuration also requires `ownershipDirectory`: one private durable directory shared by every permitted gateway invocation for that operator. A lock is derived from the fixed S3 endpoint and bucket, independent of the gateway DB path/key/account label. Exclusive creation fails a second process before its service starts. Clean shutdown releases only the current process's own lock; a crash leaves a stale lock that requires explicit operator recovery after confirming the old process is stopped. Never delete an active lock or configure different ownership directories for the same S3 connection. Only this single gateway process may write to that dedicated s3d account/bucket; parallel hosts/admin writers are unsupported and must be prevented operationally. Within the process, gateway mutations are serialized; quota reservation and upload-intent insertion additionally use one SQLite transaction with no network await inside it.
