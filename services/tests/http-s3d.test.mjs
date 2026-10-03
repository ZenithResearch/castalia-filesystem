import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { createFilesServer } from "../src/http.mjs";
import { S3D_REVISION } from "../../packages/browser/src/shipping-receipts.mjs";
import { S3dTransport } from "../src/s3d.mjs";
import {
  fixture,
  register,
  owner,
  presentation,
  appOrigin,
  digest,
} from "./helpers.mjs";
const hmac = (key, value) => createHmac("sha256", key).update(value).digest();
test("real HTTP routing rejects unknown origins, hides owner inventory, logs in once and binds sessions to origin", async (t) => {
  const f = fixture(t);
  await register(f);
  const server = createFilesServer(f.index, { kind: "index" });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const req = (path, options = {}) =>
    fetch(base + path, {
      ...options,
      headers: { origin: appOrigin, ...options.headers },
    });
  assert.equal(
    (
      await fetch(base + "/v1/config", {
        headers: { origin: "https://evil.example" },
      })
    ).status,
    403,
  );
  assert.equal((await req("/v1/submissions")).status, 401);
  const challenge = await (
    await req("/v1/auth/challenge", {
      method: "POST",
      body: JSON.stringify({ memberKey: owner }),
    })
  ).json();
  const login = await req("/v1/auth/session", {
    method: "POST",
    body: JSON.stringify({ presentation: presentation(challenge) }),
  });
  const session = await login.json();
  assert.equal(login.status, 200);
  const response = await req("/v1/namespaces/personal", {
    headers: { authorization: "Bearer " + session.token },
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.ok((await response.json()).receipt);
  assert.equal(
    (
      await req("/v1/namespaces/personal", {
        headers: {
          origin: "https://zenith.example",
          authorization: "Bearer " + session.token,
        },
      })
    ).status,
    401,
  );
  assert.equal(
    (
      await req("/v1/auth/session", {
        method: "POST",
        body: JSON.stringify({ presentation: presentation(challenge) }),
      })
    ).status,
    401,
  );
});
test("SigV4 transport uses pinned real S3 APIs, exact version GET and both actual admin counters", async () => {
  const seen = [];
  const fetchImpl = async (input, options) => {
    const url = new URL(input);
    seen.push({ url, options });
    if (url.port === "8001") {
      assert.equal(
        options.headers.authorization,
        "Basic " + Buffer.from(":admin-test-only").toString("base64"),
      );
      return new Response(
        options.method === "GET"
          ? JSON.stringify({ pendingObjects: 0, unpinnedObjects: 0 })
          : "",
      );
    }
    const headers = options.headers,
      authorization = headers.authorization;
    const signedHeaders = authorization
      .match(/SignedHeaders=([^,]+)/)[1]
      .split(";");
    const scope = authorization.match(/Credential=access\/([^,]+)/)[1];
    const canonicalHeaders = signedHeaders
      .map((name) => `${name}:${String(headers[name]).trim()}\n`)
      .join("");
    const canonical = [
      options.method,
      url.pathname,
      url.search.slice(1),
      canonicalHeaders,
      signedHeaders.join(";"),
      digest(options.body ?? Buffer.alloc(0)),
    ].join("\n");
    const [day, region, service] = scope.split("/");
    const key = hmac(
      hmac(hmac(hmac("AWS4secret", day), region), service),
      "aws4_request",
    );
    assert.equal(
      authorization.split("Signature=")[1],
      hmac(
        key,
        `AWS4-HMAC-SHA256\n${headers["x-amz-date"]}\n${scope}\n${digest(canonical)}`,
      ).toString("hex"),
    );
    if (url.searchParams.has("versioning"))
      return new Response(
        "<VersioningConfiguration><Status>Enabled</Status></VersioningConfiguration>",
      );
    if (url.searchParams.has("uploads"))
      return new Response(
        "<InitiateMultipartUploadResult><UploadId>upload-1</UploadId></InitiateMultipartUploadResult>",
      );
    if (options.method === "PUT")
      return new Response("", { headers: { etag: '"part-etag"' } });
    if (options.method === "POST")
      return new Response(
        '<CompleteMultipartUploadResult><ETag>"whole"</ETag></CompleteMultipartUploadResult>',
        { headers: { "x-amz-version-id": "version-1" } },
      );
    return new Response("ciphertext", {
      headers: { "x-amz-version-id": "version-1" },
    });
  };
  const transport = new S3dTransport({
    s3dRevision: S3D_REVISION,
    endpoint: "http://127.0.0.1:8000/",
    adminEndpoint: "http://127.0.0.1:8001/",
    accessKey: "access",
    secretKey: "secret",
    adminPassword: "admin-test-only",
    bucket: "private-bucket",
    fetchImpl,
    now: () => Date.parse("2026-10-03T22:00:00Z"),
  });
  await transport.assertVersioning();
  const uploadId = await transport.createMultipart("opaque/object", {
    ciphertextSha256: "ab".repeat(32),
    operationId: "cd".repeat(32),
  });
  assert.equal(uploadId, "upload-1");
  await transport.uploadPart(
    "opaque/object",
    uploadId,
    1,
    Buffer.from("ciphertext"),
  );
  assert.equal(
    await transport.completeMultipart("opaque/object", uploadId, [
      { partNumber: 1, etag: '"part-etag"' },
    ]),
    "version-1",
  );
  await transport.flush();
  assert.deepEqual(await transport.stats(), {
    pendingObjects: 0,
    unpinnedObjects: 0,
  });
  const stream = await transport.get("opaque/object", "version-1");
  await stream.cancel();
  assert.equal(seen.at(-1).url.searchParams.get("versionId"), "version-1");
  assert.equal(seen.at(-1).options.cache, "no-store");
  assert.equal(
    seen.find(
      (v) => v.options.method === "POST" && v.url.searchParams.has("uploadId"),
    ).options.headers["if-none-match"],
    "*",
  );
});
test("missing unpinned counter, disabled versioning and unsafe endpoints fail closed", async () => {
  const options = {
    s3dRevision: S3D_REVISION,
    endpoint: "http://127.0.0.1:8000/",
    adminEndpoint: "http://127.0.0.1:8001/",
    accessKey: "access",
    secretKey: "secret",
    adminPassword: "test",
    bucket: "private-bucket",
  };
  const t = new S3dTransport({
    ...options,
    fetchImpl: async () => new Response(JSON.stringify({ pendingObjects: 0 })),
  });
  await assert.rejects(t.stats(), { code: "invalid-s3-stats" });
  const disabled = new S3dTransport({
    ...options,
    fetchImpl: async () =>
      new Response(
        "<VersioningConfiguration><Status>Suspended</Status></VersioningConfiguration>",
      ),
  });
  await assert.rejects(disabled.assertVersioning(), {
    code: "s3-versioning-required",
  });
  assert.throws(
    () => new S3dTransport({ ...options, endpoint: "http://public.example/" }),
    { code: "invalid-origin" },
  );
});
test("IPv6 loopback origins are accepted but origin lookalikes and remote cleartext fail", async () => {
  const { origin } = await import("../src/common.mjs");
  assert.equal(origin("http://[::1]:4400"), "http://[::1]:4400");
  assert.throws(() => origin("http://[::1].evil.example"));
  assert.throws(() => origin("http://192.0.2.1"));
  assert.throws(() => origin("https://app.example/path"));
});
