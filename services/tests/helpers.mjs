import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPrivateKey, createPublicKey, sign } from "node:crypto";
import { FilesIndex } from "../src/index.mjs";
import { FilesGateway } from "../src/gateway.mjs";
import { publicHex, digest } from "../src/common.mjs";
import {
  canonicalJson,
  authChallengeBytes,
} from "../../packages/browser/src/shipping-contract.mjs";
import {
  credential,
  trustPolicy,
  genesis,
  signed,
} from "../../packages/browser/tests/registration-fixture.mjs";
import { PERSON_CLASS } from "../../packages/browser/src/registration.mjs";
export { credential, trustPolicy, genesis, signed, digest, canonicalJson };
export const key = (seed) =>
  createPrivateKey({
    key: Buffer.from("302e020100300506032b657004220420" + seed, "hex"),
    format: "der",
    type: "pkcs8",
  });
export const ownerKey = key(
  "4ccd089b28ff96da9db6c346ec114e0f5b8a319f35aba624da8cf6ed4fb8a6fb",
);
export const otherKey = key("07".repeat(32));
export const owner = publicHex(ownerKey),
  other = publicHex(otherKey),
  indexKey = key("30".repeat(32)),
  gatewayKey = key("40".repeat(32));
export const serviceId = publicHex(indexKey),
  gatewayId = publicHex(gatewayKey),
  appOrigin = "https://app.example";
export const id = (n) => n.toString(16).padStart(64, "0");
export function presentation(challenge, privateKey = ownerKey) {
  return {
    subject: {
      subjectId: `did:castalia:member:${publicHex(privateKey)}`,
      publicKey: createPublicKey(privateKey).export({
        format: "pem",
        type: "spki",
      }),
      walletKind: "castalia-dregg",
    },
    challenge,
    signature: sign(null, authChallengeBytes(challenge), privateKey).toString(
      "base64",
    ),
    signatureAlgorithm: "ed25519",
  };
}
export class FakeTransport {
  constructor() {
    this.parts = new Map();
    this.objects = new Map();
    this.pending = 0;
    this.unpinned = 0;
    this.reads = 0;
    this.completed = 0;
    this.counter = 0;
  }
  async assertVersioning() {}
  async createMultipart(key, metadata) {
    const id = String(++this.counter);
    this.parts.set(id, { key, metadata, parts: new Map() });
    if (this.loseInitialization) {
      this.loseInitialization = false;
      throw new Error("lost initiation response");
    }
    return id;
  }
  async findMultipart(key) {
    const found = [...this.parts].filter(([, v]) => v.key === key);
    if (found.length !== 1) throw new Error("ambiguous");
    return found[0][0];
  }
  async uploadPart(key, id, n, bytes) {
    this.parts.get(id).parts.set(n, Buffer.from(bytes));
    return '"' + digest(bytes) + '"';
  }
  async completeMultipart(key, id, parts) {
    const v = this.parts.get(id);
    if (!v) throw new Error("NoSuchUpload");
    const bytes = Buffer.concat(parts.map((p) => v.parts.get(p.partNumber)));
    const version = String(++this.counter);
    this.objects.set(key, { bytes, version, metadata: v.metadata });
    this.parts.delete(id);
    this.completed++;
    if (this.loseCompletion) {
      this.loseCompletion = false;
      throw new Error("lost completion response");
    }
    return version;
  }
  async head(key) {
    const v = this.objects.get(key);
    if (!v) throw new Error("missing");
    return {
      version: v.version,
      byteLength: v.bytes.length,
      ciphertextSha256: v.metadata.ciphertextSha256,
      operationId: v.metadata.operationId,
    };
  }
  async flush() {
    if (this.flushError) throw new Error("quota");
  }
  async stats() {
    return { pendingObjects: this.pending, unpinnedObjects: this.unpinned };
  }
  async get(key, version) {
    const v = this.objects.get(key);
    if (!v || v.version !== version) throw new Error("wrong version");
    this.reads++;
    const bytes = this.corrupt ? Buffer.from(v.bytes).fill(9) : v.bytes;
    return new ReadableStream({
      start(c) {
        c.enqueue(bytes);
        c.close();
      },
    });
  }
}
export function fixture(t, { realtime = false } = {}) {
  const directory = mkdtempSync(join(tmpdir(), "castalia-service-test-")),
    transport = new FakeTransport();
  let now = Date.parse("2026-10-03T21:00:00.000Z");
  const common = {
    allowedOrigins: [appOrigin, "https://zenith.example"],
    now: () => (realtime ? Date.now() : now),
  };
  const indexOptions = {
    ...common,
    databasePath: join(directory, "index.sqlite"),
    privateKey: indexKey,
    trustPolicy,
    gateways: [
      {
        gatewayId,
        allowedMembers: [owner, other],
        storageAccountId: "synthetic",
        gatewayUrl: "https://gateway.example/",
      },
    ],
  };
  const gatewayOptions = {
    ...common,
    databasePath: join(directory, "gateway.sqlite"),
    privateKey: gatewayKey,
    indexServiceIds: [serviceId],
    allowedMembers: [owner, other],
    storageAccountId: "synthetic",
    transport,
    providerName: "Synthetic provider",
    termsUrl: "https://provider.example/terms",
  };
  const f = {
    index: new FilesIndex(indexOptions),
    gateway: new FilesGateway(gatewayOptions),
    indexOptions,
    gatewayOptions,
    transport,
    advance: (ms) => {
      now += ms;
    },
  };
  t.after(() => {
    f.index.close();
    f.gateway.close();
  });
  return f;
}
export async function register(f, organization = false) {
  const manifest = await genesis(
    organization
      ? {}
      : { entityClass: PERSON_CLASS, genesisNonce: "00".repeat(32) },
  );
  const accepted = await f.index.acceptRegistration(owner, {
    chain: [signed(manifest)],
    membershipCredential: credential,
    expectedManifestDigest: null,
  });
  return { manifest, accepted };
}
export function intent(
  f,
  manifest,
  {
    operationId = id(1),
    submissionId = id(2),
    revisionId = id(3),
    expectedRevisionId = null,
    bytes = Buffer.alloc(32, 7),
    memberKey = owner,
  } = {},
) {
  const binding = {
    schema: "castalia.files-key-binding.v1",
    ownerMemberKey: memberKey,
    serviceId,
    storageAccountId: "synthetic",
    namespaceId: manifest.namespaceId,
    workspaceId: manifest.initialWorkspaceId,
    submissionId,
    revisionId,
  };
  const input = {
    operationId,
    binding,
    expectedRevisionId,
    ciphertextSha256: digest(bytes),
    byteLength: bytes.length,
    gatewayId,
  };
  return {
    bytes,
    binding,
    input,
    signedIntent: f.index.createIntent(memberKey, input),
  };
}
export async function stored(f, shipment) {
  await f.gateway.upload(
    shipment.binding.ownerMemberKey,
    shipment.signedIntent,
  );
  await f.gateway.putPart(
    shipment.binding.ownerMemberKey,
    shipment.input.operationId,
    1,
    shipment.bytes,
  );
  return f.gateway.complete(
    shipment.binding.ownerMemberKey,
    shipment.input.operationId,
  );
}
export function commitInput(shipment, storageReceipt) {
  const keyEnvelope = {
      schema: "castalia.files-key-envelope.v1",
      binding: shipment.binding,
      nonce: Buffer.alloc(12).toString("base64url"),
      ciphertext: Buffer.alloc(48).toString("base64url"),
    },
    nonce = Buffer.alloc(12, 1).toString("base64url");
  return {
    operationId: shipment.input.operationId,
    storageReceipt,
    descriptorDigest: digest({
      binding: shipment.binding,
      keyEnvelope,
      nonce,
      ciphertextSha256: shipment.input.ciphertextSha256,
    }),
    keyEnvelope,
    nonce,
  };
}
