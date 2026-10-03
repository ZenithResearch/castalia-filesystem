// SPDX-License-Identifier: AGPL-3.0-or-later
import { createServer } from "node:http";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { ServiceError, exact, fail } from "./common.mjs";
import { UPLOAD_PART_BYTES } from "../../packages/browser/src/shipping-receipts.mjs";
async function body(req, limit, json = true) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) fail("request-too-large", undefined, 413);
    chunks.push(chunk);
  }
  const bytes = Buffer.concat(chunks);
  if (!json) return bytes;
  try {
    return bytes.length ? JSON.parse(bytes.toString("utf8")) : {};
  } catch {
    fail("invalid-json");
  }
}
export function createFilesServer(service, { kind }) {
  const server = createServer(async (req, res) => {
    res.setHeader("cache-control", "no-store");
    res.setHeader("x-content-type-options", "nosniff");
    res.setHeader("vary", "Origin");
    try {
      const requestOrigin = req.headers.origin;
      service.auth.checkOrigin(requestOrigin);
      res.setHeader("access-control-allow-origin", requestOrigin);
      if (req.method === "OPTIONS") {
        res.setHeader(
          "access-control-allow-methods",
          "GET, POST, PUT, DELETE, OPTIONS",
        );
        res.setHeader(
          "access-control-allow-headers",
          "Authorization, Content-Type",
        );
        res.statusCode = 204;
        res.end();
        return;
      }
      const url = new URL(req.url, "http://internal.invalid");
      if (url.search) fail("unexpected-query");
      const path = url.pathname;
      let result;
      if (req.method === "GET" && path === "/v1/config")
        result = service.config();
      else if (req.method === "POST" && path === "/v1/auth/challenge") {
        const b = await body(req, 1024);
        exact(b, ["memberKey"]);
        result = service.auth.challenge(b.memberKey, requestOrigin);
      } else if (req.method === "POST" && path === "/v1/auth/session") {
        const b = await body(req, 16384);
        exact(b, ["presentation"]);
        result = service.auth.login(b.presentation, requestOrigin);
      } else {
        const token =
          typeof req.headers.authorization === "string" &&
          req.headers.authorization.startsWith("Bearer ")
            ? req.headers.authorization.slice(7)
            : "";
        const owner = service.auth.owner(token, requestOrigin);
        if (req.method === "DELETE" && path === "/v1/auth/session") {
          service.auth.logout(token, requestOrigin);
          result = { loggedOut: true };
        } else if (kind === "index") {
          if (req.method === "GET" && path === "/v1/namespaces/personal")
            result = service.personal(owner);
          else if (req.method === "GET" && path === "/v1/namespaces")
            result = service.namespaces(owner);
          else if (req.method === "GET" && path === "/v1/destinations")
            result = service.destinations(owner);
          else if (req.method === "POST" && path === "/v1/registrations/accept")
            result = await service.acceptRegistration(
              owner,
              await body(req, 1024 * 1024),
            );
          else if (req.method === "POST" && path === "/v1/upload-intents")
            result = service.createIntent(owner, await body(req, 16384));
          else if (req.method === "POST" && path === "/v1/submissions/commit")
            result = service.commit(owner, await body(req, 32768));
          else if (req.method === "GET" && path === "/v1/submissions")
            result = service.inventory(owner);
          else if (req.method === "GET" && path === "/v1/connections")
            result = service.connections(owner);
          else if (req.method === "PUT" && path === "/v1/connections")
            result = service.saveConnection(owner, await body(req, 8192));
          else if (req.method === "POST" && path === "/v1/grants")
            result = service.setGrant(owner, await body(req, 8192));
          else if (req.method === "POST" && path === "/v1/grants/revoke")
            result = service.revokeGrant(owner, await body(req, 8192));
          else if (
            req.method === "GET" &&
            /^\/v1\/operations\/[a-f0-9]{64}$/.test(path)
          )
            result = service.operation(owner, path.split("/")[3]);
          else if (
            req.method === "GET" &&
            /^\/v1\/submissions\/[a-f0-9]{64}\/history$/.test(path)
          )
            result = service.history(owner, path.split("/")[3]);
          else if (
            req.method === "GET" &&
            /^\/v1\/submissions\/[a-f0-9]{64}\/revisions\/[a-f0-9]{64}$/.test(
              path,
            )
          )
            result = service.revision(
              owner,
              path.split("/")[3],
              path.split("/")[5],
            );
          else if (
            req.method === "POST" &&
            /^\/v1\/submissions\/[a-f0-9]{64}\/withdraw$/.test(path)
          ) {
            const b = await body(req, 1024);
            exact(b, ["expectedRevisionId"]);
            result = service.withdraw(owner, {
              submissionId: path.split("/")[3],
              expectedRevisionId: b.expectedRevisionId,
            });
          } else fail("not-found", undefined, 404);
        } else if (kind === "gateway") {
          if (req.method === "POST" && path === "/v1/uploads") {
            const b = await body(req, 16384);
            exact(b, ["intent"]);
            result = await service.upload(owner, b.intent);
          } else if (
            req.method === "GET" &&
            /^\/v1\/uploads\/[a-f0-9]{64}$/.test(path)
          )
            result = service.status(owner, path.split("/")[3]);
          else if (
            req.method === "PUT" &&
            /^\/v1\/uploads\/[a-f0-9]{64}\/parts\/[1-9][0-9]{0,3}$/.test(path)
          )
            result = await service.putPart(
              owner,
              path.split("/")[3],
              Number(path.split("/")[5]),
              await body(req, UPLOAD_PART_BYTES, false),
            );
          else if (
            req.method === "POST" &&
            /^\/v1\/uploads\/[a-f0-9]{64}\/complete$/.test(path)
          ) {
            exact(await body(req, 1024), []);
            result = await service.complete(owner, path.split("/")[3]);
          } else if (
            req.method === "GET" &&
            /^\/v1\/objects\/[a-f0-9]{64}$/.test(path)
          ) {
            const { stream, receipt } = await service.download(
              owner,
              path.split("/")[3],
            );
            res.setHeader("content-type", "application/octet-stream");
            res.setHeader("content-length", String(receipt.payload.byteLength));
            await pipeline(Readable.fromWeb(stream), res);
            return;
          } else fail("not-found", undefined, 404);
        } else fail("invalid-service-kind");
      }
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(result));
    } catch (error) {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      res.statusCode = error instanceof ServiceError ? error.status : 400;
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          error: error instanceof ServiceError ? error.code : "invalid-request",
        }),
      );
    }
  });
  server.requestTimeout = 180000;
  server.headersTimeout = 10000;
  server.keepAliveTimeout = 5000;
  return server;
}
