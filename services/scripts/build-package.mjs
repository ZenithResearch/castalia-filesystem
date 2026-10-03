// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  lstatSync,
  copyFileSync,
  existsSync,
} from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
if (process.version !== "v24.18.0") throw new Error("Use pinned Node 24.18.0");
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../.."),
  output = resolve(process.argv[2] ?? "");
if (!process.argv[2] || output === root || output.startsWith(root + "/"))
  throw new Error("Provide a new output path outside the source checkout");
if (existsSync(output)) throw new Error("Output already exists");
mkdirSync(output, { recursive: true });
const paths = [
  "LICENSE",
  "PROVENANCE.md",
  "services/README.md",
  "services/package.json",
  "services/package-lock.json",
  "services/s3d-release.json",
];
for (const directory of ["services/src", "services/scripts", "services/tests"])
  for (const entry of readdirSync(join(root, directory)).sort()) {
    if (directory === "services/tests" && entry === "browser-shipping.test.mjs")
      continue;
    const path = join(directory, entry);
    if (
      !lstatSync(join(root, path)).isFile() ||
      lstatSync(join(root, path)).isSymbolicLink()
    )
      throw new Error("Unexpected package entry");
    paths.push(path);
  }
for (const name of [
  "address.mjs",
  "registration.mjs",
  "registration-membership.mjs",
  "registration-crypto.mjs",
  "shipping-contract.mjs",
  "shipping-receipts.mjs",
])
  paths.push("packages/browser/src/" + name);
// Test fixtures are synthetic, preserved from the existing registration vectors.
for (const name of [
  "registration-fixture.mjs",
  "fixtures/base-membership-v3.json",
])
  paths.push("packages/browser/tests/" + name);
const files = [];
for (const path of paths.sort()) {
  const bytes = readFileSync(join(root, path));
  mkdirSync(dirname(join(output, path)), { recursive: true });
  copyFileSync(join(root, path), join(output, path));
  files.push({
    path,
    bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  });
}
const revision = execFileSync("git", ["rev-parse", "HEAD"], {
  cwd: root,
  encoding: "utf8",
}).trim();
const dirty =
  execFileSync("git", ["status", "--porcelain"], {
    cwd: root,
    encoding: "utf8",
  }).trim().length > 0;
const manifest = {
  schema: "castalia.files-services-package.v1",
  sourceRevision: revision,
  sourceDirty: dirty,
  excludedIntegrationTests: [
    "services/tests/browser-shipping.test.mjs (runs against full browser source with its reviewed fake-indexeddb development dependency)",
  ],
  node: "24.18.0",
  s3dRevision: "e468d007cfc9eefa083d09b5a858ba294f64f6cf",
  files,
};
writeFileSync(
  join(output, "manifest.json"),
  JSON.stringify(manifest, null, 2) + "\n",
);
console.log(
  JSON.stringify({
    output,
    sourceRevision: revision,
    sourceDirty: dirty,
    excludedIntegrationTests: [
      "services/tests/browser-shipping.test.mjs (runs against full browser source with its reviewed fake-indexeddb development dependency)",
    ],
    files: files.length,
    manifestSha256: createHash("sha256")
      .update(readFileSync(join(output, "manifest.json")))
      .digest("hex"),
  }),
);
