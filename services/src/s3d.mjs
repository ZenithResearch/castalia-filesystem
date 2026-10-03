// SPDX-License-Identifier: AGPL-3.0-or-later
import { createHmac } from "node:crypto";
import { digest, fail, origin } from "./common.mjs";
import {
  UPLOAD_PART_BYTES,
  S3D_REVISION,
} from "../../packages/browser/src/shipping-receipts.mjs";
const escape = (v) =>
  String(v)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
const awsEncode = (v) =>
  encodeURIComponent(v).replace(
    /[!'()*]/g,
    (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase(),
  );
function xmlValue(xml, name) {
  if (xml.length > 1048576 || /<!DOCTYPE|<!ENTITY/i.test(xml))
    fail("invalid-s3-response");
  const matches = [
    ...xml.matchAll(new RegExp(`<${name}>([^<]*)</${name}>`, "g")),
  ];
  if (matches.length !== 1) fail("invalid-s3-response");
  return matches[0][1].replace(
    /&(quot|apos|lt|gt|amp);/g,
    (_, v) => ({ quot: '"', apos: "'", lt: "<", gt: ">", amp: "&" })[v],
  );
}
async function boundedText(response, limit = 1048576) {
  let length = 0;
  const parts = [];
  for await (const bytes of response.body) {
    length += bytes.length;
    if (length > limit) fail("s3-response-limit", undefined, 502);
    parts.push(bytes);
  }
  return Buffer.concat(parts).toString("utf8");
}
const hmac = (key, value) => createHmac("sha256", key).update(value).digest();
/** Dependency-free Signature V4 transport for the pinned official s3d S3 surface. */
export class S3dTransport {
  constructor({
    endpoint,
    adminEndpoint,
    accessKey,
    secretKey,
    adminPassword,
    bucket,
    s3dRevision,
    region = "us-east-1",
    fetchImpl = fetch,
    now = Date.now,
  }) {
    if (s3dRevision !== S3D_REVISION) fail("unsupported-s3d-revision");
    for (const value of [endpoint, adminEndpoint]) {
      const u = new URL(value);
      origin(u.origin);
      if (u.username || u.password || u.search || u.hash || u.pathname !== "/")
        fail("invalid-s3-endpoint");
    }
    if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket))
      fail("invalid-bucket");
    Object.assign(this, {
      endpoint,
      adminEndpoint,
      accessKey,
      secretKey,
      adminPassword,
      bucket,
      region,
      fetch: fetchImpl,
      now,
    });
  }
  async request(
    method,
    key = "",
    query = {},
    body = Buffer.alloc(0),
    extra = {},
  ) {
    const endpoint = new URL(this.endpoint);
    const path =
      "/" +
      awsEncode(this.bucket) +
      (key ? "/" + key.split("/").map(awsEncode).join("/") : "");
    const search = Object.entries(query)
      .map(([k, v]) => [awsEncode(k), awsEncode(String(v))])
      .sort(([a, av], [b, bv]) =>
        a < b ? -1 : a > b ? 1 : av < bv ? -1 : av > bv ? 1 : 0,
      )
      .map(([k, v]) => `${k}=${v}`)
      .join("&");
    const date = new Date(this.now())
      .toISOString()
      .replace(/[-:]|\.\d{3}/g, "");
    const day = date.slice(0, 8),
      scope = `${day}/${this.region}/s3/aws4_request`;
    const headers = {
      ...extra,
      host: endpoint.host,
      "x-amz-date": date,
      "x-amz-content-sha256": digest(body),
    };
    const names = Object.keys(headers).sort();
    const canonicalHeaders = names
      .map((k) => `${k}:${String(headers[k]).trim().replace(/\s+/g, " ")}\n`)
      .join("");
    const canonical = [
      method,
      path,
      search,
      canonicalHeaders,
      names.join(";"),
      headers["x-amz-content-sha256"],
    ].join("\n");
    const signingKey = hmac(
      hmac(hmac(hmac("AWS4" + this.secretKey, day), this.region), "s3"),
      "aws4_request",
    );
    const signature = hmac(
      signingKey,
      `AWS4-HMAC-SHA256\n${date}\n${scope}\n${digest(canonical)}`,
    ).toString("hex");
    headers.authorization = `AWS4-HMAC-SHA256 Credential=${this.accessKey}/${scope}, SignedHeaders=${names.join(";")}, Signature=${signature}`;
    const response = await this.fetch(
      `${endpoint.origin}${path}${search ? "?" + search : ""}`,
      {
        method,
        headers,
        body: ["GET", "HEAD"].includes(method) ? undefined : body,
        redirect: "error",
        cache: "no-store",
        signal: AbortSignal.timeout(120000),
      },
    );
    if (!response.ok) {
      await response.body?.cancel();
      fail(
        "s3-request-failed",
        `S3 ${method} returned ${response.status}`,
        502,
      );
    }
    return response;
  }
  async assertVersioning() {
    const r = await this.request("GET", "", { versioning: "" });
    if (xmlValue(await boundedText(r), "Status") !== "Enabled")
      fail("s3-versioning-required", undefined, 503);
  }
  async createMultipart(key, metadata) {
    const response = await this.request(
      "POST",
      key,
      { uploads: "" },
      Buffer.alloc(0),
      {
        "x-amz-meta-castalia-sha256": metadata.ciphertextSha256,
        "x-amz-meta-castalia-operation": metadata.operationId,
      },
    );
    return xmlValue(await boundedText(response), "UploadId");
  }
  async findMultipart(key) {
    const response = await this.request("GET", "", {
      uploads: "",
      prefix: key,
      "max-uploads": 1000,
    });
    const xml = await boundedText(response);
    if (xmlValue(xml, "IsTruncated") !== "false")
      fail("multipart-recovery-ambiguous", undefined, 409);
    const matches = [...xml.matchAll(/<Upload>([\s\S]*?)<\/Upload>/g)]
      .filter((v) => xmlValue(v[1], "Key") === key)
      .map((v) => xmlValue(v[1], "UploadId"));
    if (matches.length !== 1)
      fail("multipart-recovery-ambiguous", undefined, 409);
    return matches[0];
  }
  async uploadPart(key, uploadId, partNumber, bytes) {
    if (bytes.length > UPLOAD_PART_BYTES) fail("part-limit");
    const r = await this.request("PUT", key, { uploadId, partNumber }, bytes);
    const etag = r.headers.get("etag");
    await r.body?.cancel();
    if (!etag || etag.length > 256 || /[\r\n<>]/.test(etag))
      fail("invalid-s3-etag");
    return etag;
  }
  async completeMultipart(key, uploadId, parts) {
    const body = Buffer.from(
      "<CompleteMultipartUpload>" +
        parts
          .map(
            (p) =>
              `<Part><PartNumber>${p.partNumber}</PartNumber><ETag>${escape(p.etag)}</ETag></Part>`,
          )
          .join("") +
        "</CompleteMultipartUpload>",
    );
    const r = await this.request("POST", key, { uploadId }, body, {
      "content-type": "application/xml",
      "if-none-match": "*",
    });
    const text = await boundedText(r);
    xmlValue(text, "ETag");
    const version = r.headers.get("x-amz-version-id");
    if (!version || version === "null")
      fail("s3-version-required", undefined, 502);
    return version;
  }
  async head(key) {
    const r = await this.request("HEAD", key);
    const version = r.headers.get("x-amz-version-id");
    if (!version || version === "null")
      fail("s3-version-required", undefined, 502);
    return {
      version,
      byteLength: Number(r.headers.get("content-length")),
      ciphertextSha256: r.headers.get("x-amz-meta-castalia-sha256"),
      operationId: r.headers.get("x-amz-meta-castalia-operation"),
    };
  }
  async get(key, version) {
    const r = await this.request("GET", key, { versionId: version });
    if (r.headers.get("x-amz-version-id") !== version) {
      await r.body?.cancel();
      fail("s3-version-mismatch", undefined, 502);
    }
    return r.body;
  }
  async admin(path, method) {
    const r = await this.fetch(new URL(path, this.adminEndpoint), {
      method,
      headers: {
        authorization:
          "Basic " + Buffer.from(":" + this.adminPassword).toString("base64"),
      },
      redirect: "error",
      cache: "no-store",
      signal: AbortSignal.timeout(600000),
    });
    if (!r.ok) {
      await r.body?.cancel();
      fail("s3-admin-failed", `s3d admin returned ${r.status}`, 502);
    }
    return r;
  }
  async flush() {
    const r = await this.admin("/objects/flush", "POST");
    await r.body?.cancel();
  }
  async stats() {
    const r = await this.admin("/stats/uploads", "GET");
    const text = await boundedText(r);
    if (text.length > 65536) fail("invalid-s3-stats");
    const v = JSON.parse(text);
    for (const key of ["pendingObjects", "unpinnedObjects"])
      if (!Number.isSafeInteger(v[key]) || v[key] < 0) fail("invalid-s3-stats");
    return {
      pendingObjects: v.pendingObjects,
      unpinnedObjects: v.unpinnedObjects,
    };
  }
}
