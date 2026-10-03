# Identity and namespace registration boundary

This is the source mapping for the browser registration candidate. It is a new local signed-manifest contract, not an existing deployed registry. Snapshot v1, wallet identity, membership and recovery formats remain unchanged.

## Authoritative inputs and unresolved mappings

| Input | Reviewed source | Meaning here |
| --- | --- | --- |
| Member Key | Wallet `52ee41ad03af8f256601c1c21c33e55d876a5380`, `docs/castalia-member-key-and-membership-cell.md` and `packages/zenith-membership/src/index.ts` | Existing 32-byte Ed25519 public key; use existing custody to sign, without creating a new identity or recovery format. |
| Castalia base membership | The same Wallet revision, canonical `castalia.zenith-membership-credential.v3` | A verified active v3 credential under an explicitly supplied trusted issuer policy establishes creation eligibility. Its Zenith wire name identifies the current issuer; it is Castalia base membership. It does not grant control over existing organizations or file access. |
| Entity classes | Devgraph ontology v0.6.0, release digest `11d670a57b2052b4de00509559d081b524bf953c6da2544a25f33976857f8f4f` | `https://zenith-research.ca/ontology/terms/Person` and `https://zenith-research.ca/ontology/terms/Organization` classify entities. Classes and paths are not authorization subjects or grants. |
| Entity allocator | No implemented allocator found in the reviewed ontology, Directory placeholders or Control proposals | New local registration genesis allocates an opaque entity reference bound to the creator and public randomness. This is a new contract, not a claimed existing Devgraph identity service. Existing entity references require accepted controller evidence; names never claim them. |
| Castalia universe / federation | No authoritative record located | Unresolved. Neither human-readable names, Dregg network fixtures nor the Web v4 Zenith community scope substitute for these IDs. These mappings stay outside the registration envelope and physical storage address. Their absence does not block valid base-v3 local registration. |

The v4 Zenith community scope `a0065f491f2827d40732c837ac3af6f20b2ff8f3f16d5abe86d96ef8ba0fcc85` is a scoped community identifier, not a federation or universe record. The older website ontology bundle is not the canonical entity-class source above. Directory entries are placeholders, and the strict `.castaway` Person profile format does not allocate organizations or controllers.

## Local registration and reviewed acceptance

A member can register a personal namespace and create new organizations. Each organization has exactly one namespace, with multiple child workspaces or projects beneath that root. An organization is distinct from its controller Member Key: a controller can create multiple organizations, and later controller updates do not change the entity or namespace identity.

A genesis manifest binds the new entity, initial controller, namespace and initial workspace. It uses a new domain-separated transcript signed by the existing Ed25519 Member Key. Fresh wallet consent binds the exact manifest digest, actual requesting origin, audience, nonce and deadline; consent is separate from the durable manifest. Auth login transcripts remain unchanged. Updates require the current controller and the previous manifest digest; local publication uses compare-and-swap to reject concurrent forks and rollback.

A signature establishes authorship and a controller chain, not approval of a canonical registry path. Creating an organization named Zenith does not acquire the existing Zenith entity or `/Organization/Zenith/`. Canonical mounting requires an explicitly reviewed manifest index that accepts the exact entity, namespace and genesis digest. An application can alias that accepted mount to its own `/`; aliases do not copy data or synchronize browser origins. No live registry service, capability provider, automatic membership-based access or cross-origin sync is included.

Registration/entity/controller state, namespace uniqueness and the initial workspace catalog publish in one IndexedDB transaction after external verification. A transaction abort exposes none of those records. Existing controller updates compare the accepted previous digest inside that transaction. Membership eligibility and classification never replace that controller check.

## Storage and legacy compatibility

Physical addresses use only `{ namespaceId, workspaceId }`, each a canonical 32-byte lowercase hex identifier. An accepted workspace also binds an immutable entity reference and registration genesis digest. Workspaces beneath the same organization have independent catalogs, heads, revisions, Web Locks and object directories. The existing Rust snapshot constructor receives the organization namespace ID for new workspaces; the snapshot root CID is a different value.

The database remains `castalia-browser-filesystem` version 2 with the `catalog` store. Existing string key `workspace` and legacy OPFS objects remain untouched. New records use compound keys; new workspace rows contain the existing strict-v1 catalog as a nested value. This preserves old readers and stored data without a schema migration. New scoped OPFS data lives below `castalia-filesystem-scoped-v1/<namespaceId>/<workspaceId>/`.

The legacy mount remains visible. Copying legacy files to a selected new workspace requires explicit ZIP export/import; it never rewrites the legacy snapshot namespace or silently adopts it. `.castaway` continues to contain data and proofs, while signing recovery remains separate.

## Qualification and licensing

The maintained core and registration modules retain their AGPL-3.0-or-later declarations. Browser adapter provenance identifies the Web source and supplemental inferred origins without inventing an absent permissive grant. Exact consumer policy acceptance is assessed separately from unresolved Web/Wallet source permissions. An allowed dependency declaration or matching artifact does not establish those permissions; no grant, inventory exclusion or relicensing is created by this extraction.

Source, unit and browser acceptance evidence are separate gates. Registration tests must cover signature/body binding, v3 eligibility, controller updates, duplicate organization roots, namespace and workspace isolation, unknown schemas, transaction aborts and concurrent publication. Browser tests must additionally cover real IndexedDB completion/abort and scoped worker/recovery/cleanup behavior.
