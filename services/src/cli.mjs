// SPDX-License-Identifier: AGPL-3.0-or-later
import { readFileSync, lstatSync } from "node:fs";
import { createPrivateKey } from "node:crypto";
import { FilesIndex } from "./index.mjs";
import { FilesGateway } from "./gateway.mjs";
import { S3dTransport } from "./s3d.mjs";
import { createFilesServer } from "./http.mjs";
process.umask(0o077);
if (process.version !== "v24.18.0")
  throw new Error("Use the pinned Node 24.18.0 runtime");
const [kind, path] = process.argv.slice(2);
if (!["index", "gateway"].includes(kind) || !path)
  throw new Error(
    "Usage: node src/cli.mjs index|gateway /private/path/config.json",
  );
const stat = lstatSync(path);
if (
  !stat.isFile() ||
  stat.isSymbolicLink() ||
  stat.nlink !== 1 ||
  stat.mode & 0o077
)
  throw new Error("Configuration must be a private regular file (0600)");
const config = JSON.parse(readFileSync(path, "utf8"));
const ks = lstatSync(config.signingKeyFile);
if (!ks.isFile() || ks.isSymbolicLink() || ks.nlink !== 1 || ks.mode & 0o077)
  throw new Error("Signing key must be a private regular file (0600)");
const privateKey = createPrivateKey(readFileSync(config.signingKeyFile));
const options = { ...config, privateKey };
const service =
  kind === "index"
    ? new FilesIndex(options)
    : new FilesGateway({ ...options, transport: new S3dTransport(config.s3d) });
const server = createFilesServer(service, { kind });
server.listen(config.port, config.host ?? "127.0.0.1", () => {
  console.log(
    `${kind} service listening on configured address; identity ${kind === "index" ? service.serviceId : service.gatewayId}`,
  );
});
for (const signal of ["SIGINT", "SIGTERM"])
  process.once(signal, () =>
    server.close(() => {
      service.close();
      process.exit(0);
    }),
  );
