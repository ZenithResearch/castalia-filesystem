import { readFile, writeFile, mkdir, copyFile, cp } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  command,
  lockedMetadata,
  RUST_TOOLCHAIN,
  NODE_VERSION,
} from "./lib/process.mjs";
import {
  digest,
  inventory,
  verifyPackage,
  MANIFEST,
  SCHEMA,
  REPOSITORY,
} from "./lib/package-manifest.mjs";
import { stripWasmNameSection } from "./lib/strip-wasm-name.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
let output;
let development = false;
while (args.length) {
  const arg = args.shift();
  if (arg === "--out-dir" && args.length && !output)
    output = resolve(args.shift());
  else if (arg === "--development" && !development) development = true;
  else throw new Error(`unknown or incomplete argument: ${arg}`);
}
if (!output)
  throw new Error(
    "usage: build-package.mjs --out-dir NEW_DIRECTORY [--development]",
  );
if (process.versions.node !== NODE_VERSION)
  throw new Error(`Node ${NODE_VERSION} is required`);
const git = (...values) => command("git", ["-C", root, ...values]);
const revision = git("rev-parse", "HEAD");
const status = () => git("status", "--porcelain", "--untracked-files=all");
const initialStatus = status();
if (initialStatus && !development)
  throw new Error("candidate source must be clean and committed");
const env = {
  ...process.env,
  RUSTUP_TOOLCHAIN: RUST_TOOLCHAIN,
  CARGO_NET_OFFLINE: "true",
  CARGO_BUILD_JOBS: "1",
  CARGO_TARGET_DIR: process.env.CARGO_TARGET_DIR || join(root, "target"),
  RUSTFLAGS: `--remap-path-prefix=${root}=/castalia-source`,
};
const options = { cwd: root, env };
const tools = {
  rustToolchain: RUST_TOOLCHAIN,
  rustc: command("rustc", [`+${RUST_TOOLCHAIN}`, "--version"], options),
  cargo: command("cargo", [`+${RUST_TOOLCHAIN}`, "--version"], options),
  node: process.versions.node,
  wasmPack: command("wasm-pack", ["--version"], options),
  wasmBindgen: command("wasm-bindgen", ["--version"], options),
};
if (
  tools.wasmPack !== "wasm-pack 0.14.0" ||
  tools.wasmBindgen !== "wasm-bindgen 0.2.127"
) {
  throw new Error("pinned wasm-pack and wasm-bindgen tools are required");
}
const locks = {};
for (const path of [
  "Cargo.lock",
  "castalia-filesystem-wasm/Cargo.lock",
  "package-lock.json",
]) {
  locks[path] = digest(await readFile(join(root, path)));
}
for (const manifest of ["Cargo.toml", "castalia-filesystem-wasm/Cargo.toml"]) {
  const metadata = lockedMetadata(join(root, manifest), options);
  for (const item of metadata.packages) {
    if (
      item.source === null &&
      !["castalia-filesystem-core", "castalia-filesystem-wasm"].includes(
        item.name,
      )
    ) {
      throw new Error(`unexpected local dependency: ${item.name}`);
    }
    if (item.source !== null && !item.source.startsWith("registry+")) {
      throw new Error(`nonregistry dependency: ${item.name}`);
    }
  }
}
await mkdir(output); // Never overwrite a prior candidate or its acceptance evidence.
for (const [target, folder] of [
  ["web", "web"],
  ["nodejs", "node"],
]) {
  command(
    "wasm-pack",
    [
      "build",
      join(root, "castalia-filesystem-wasm"),
      "--target",
      target,
      "--release",
      "--mode",
      "no-install",
      "--no-opt",
      "--out-dir",
      join(output, folder),
      "--",
      "--locked",
      "--offline",
    ],
    options,
  );
  const wasm = join(output, folder, "castalia_filesystem_wasm_bg.wasm");
  await writeFile(wasm, stripWasmNameSection(await readFile(wasm)));
  const packagePath = join(output, folder, "package.json");
  const metadata = JSON.parse(await readFile(packagePath, "utf8"));
  metadata.private = true;
  metadata.castaliaSourceRevision = revision;
  await writeFile(packagePath, `${JSON.stringify(metadata, null, 2)}\n`);
}
console.log(
  command(
    process.execPath,
    [
      join(root, "castalia-filesystem-wasm/tests/parity.mjs"),
      join(output, "node"),
    ],
    options,
  ),
);
await copyFile(join(root, "LICENSE"), join(output, "LICENSE"));
await copyFile(
  join(root, "docs/SNAPSHOT-V1.md"),
  join(output, "SNAPSHOT-V1.md"),
);
// Include the same documented source/provenance/license inventory as the private npm package.
for (const path of ["package.json", "package-lock.json", "README.md"]) {
  await copyFile(join(root, path), join(output, path));
}
for (const path of ["packages/browser/src", "docs", "provenance", "licenses"]) {
  await cp(join(root, path), join(output, path), {
    recursive: true,
    dereference: false,
  });
}
for (const [path, expected] of Object.entries(locks)) {
  if (digest(await readFile(join(root, path))) !== expected)
    throw new Error(`lock changed during build: ${path}`);
}
if (git("rev-parse", "HEAD") !== revision || status() !== initialStatus) {
  throw new Error("source changed during build");
}
const manifest = {
  schema: SCHEMA,
  source: {
    repository: REPOSITORY,
    revision,
    dirty: Boolean(initialStatus),
    mode: development ? "development" : "candidate",
  },
  tools,
  locks,
  normalization: "remove-only-wasm-name-section",
  files: await inventory(output),
};
const bytes = `${JSON.stringify(manifest, null, 2)}\n`;
await writeFile(join(output, MANIFEST), bytes);
const sha256 = digest(bytes);
await verifyPackage(output, sha256, revision, { development });
console.log(
  JSON.stringify({
    directory: output,
    sourceRevision: revision,
    manifestSha256: sha256,
    files: manifest.files.length,
  }),
);
