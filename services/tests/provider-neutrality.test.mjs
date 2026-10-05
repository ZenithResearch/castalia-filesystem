import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { FilesIndex } from "../src/index.mjs";
import {
  fixture,
  owner,
  other,
  credential,
  genesis,
  signed,
} from "./helpers.mjs";
import { baseMembershipSigningBytes } from "../../packages/browser/src/registration-membership.mjs";
import {
  registrationManifestDigest,
  PERSON_CLASS,
} from "../../packages/browser/src/registration.mjs";

function issue(issuerId) {
  const keys = generateKeyPairSync("ed25519");
  const claims = { ...credential, issuerId, issuerKeyId: "independent-key" };
  return {
    credential: {
      ...claims,
      issuerSignature: sign(
        null,
        baseMembershipSigningBytes(claims),
        keys.privateKey,
      ).toString("base64url"),
    },
    root: {
      issuerId,
      keyId: claims.issuerKeyId,
      signatureSuite: "Ed25519",
      publicKey: keys.publicKey
        .export({ format: "der", type: "spki" })
        .subarray(-32)
        .toString("hex"),
    },
  };
}
test("index independently accepts either configured base issuer; Wallet trust is never receiver authority", async (t) => {
  for (const name of ["independent-a", "independent-b"]) {
    const f = fixture(t),
      a = issue(name),
      untrusted = issue("untrusted");
    f.index.close();
    f.indexOptions.trustPolicy = {
      ...f.indexOptions.trustPolicy,
      roots: [a.root],
    };
    f.index = new FilesIndex(f.indexOptions);
    const manifest = await genesis({
        entityClass: PERSON_CLASS,
        genesisNonce: "00".repeat(32),
      }),
      chain = [signed(manifest)];
    for (const proof of [
      credential,
      untrusted.credential,
      {
        ...a.credential,
        schema: "castalia.scoped-membership-credential.v4",
        version: 4,
      },
      { ...a.credential, ownerPublicKey: other },
    ])
      await assert.rejects(
        f.index.acceptRegistration(owner, {
          chain,
          membershipCredential: proof,
          expectedManifestDigest: null,
        }),
      );
    const accepted = await f.index.acceptRegistration(owner, {
      chain,
      membershipCredential: a.credential,
      expectedManifestDigest: null,
    });
    assert.ok(accepted.receipt);
    assert.equal(
      f.index.personal(owner).registration.membershipCredential.issuerId,
      name,
    );
    const changed = {
      ...manifest,
      revision: 1,
      previousManifestDigest: await registrationManifestDigest(manifest),
      displayName: "Updated label",
    };
    await assert.rejects(
      f.index.acceptRegistration(other, {
        chain: [...chain, signed(changed, true)],
        membershipCredential: a.credential,
        expectedManifestDigest: await registrationManifestDigest(manifest),
      }),
    );
    await assert.rejects(
      f.index.acceptRegistration(owner, {
        chain: [...chain, signed(changed)],
        membershipCredential: a.credential,
        expectedManifestDigest: "ff".repeat(32),
      }),
    );
  }
});
