import { readFile, writeFile, mkdir, copyFile } from "node:fs/promises";
import { homedir } from "node:os";
import { canonicalBuildFlags } from "./lib/build-paths.mjs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { command, lockedMetadata, RUST_TOOLCHAIN, NODE_VERSION } from "./lib/process.mjs";
import { digest, inventory, verifyPackage, MANIFEST, SCHEMA, REPOSITORY } from "./lib/package-manifest.mjs";
import { assertBindingToolProducers } from "./lib/binding-producers.mjs";
import { stripWasmNameSection } from "./lib/strip-wasm-name.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
let output;
let development = false;
while (args.length) {
  const arg = args.shift();
  if (arg === "--out-dir" && args.length && !output) output = resolve(args.shift());
  else if (arg === "--development" && !development) development = true;
  else throw new Error(`unknown or incomplete argument: ${arg}`);
}
if (!output) throw new Error("usage: build-package.mjs --out-dir NEW_DIRECTORY [--development]");
if (process.versions.node !== NODE_VERSION) throw new Error(`Node ${NODE_VERSION} is required`);
const git = (...values) => command("git", ["-C", root, ...values]);
const revision = git("rev-parse", "HEAD");
const status = () => git("status", "--porcelain", "--untracked-files=all");
const initialStatus = status();
if (initialStatus && !development) throw new Error("candidate source must be clean and committed");
const compilerInfo = command("rustc", [`+${RUST_TOOLCHAIN}`, "-vV"]);
const compilerCommit = /^commit-hash: ([0-9a-f]{40})$/m.exec(compilerInfo)?.[1];
const rustHost = /^host: (.+)$/m.exec(compilerInfo)?.[1];
if(rustHost!=="aarch64-apple-darwin")throw new Error("canonical candidate builder requires aarch64-apple-darwin; Linux remains a portability test host");
const sysroot = command("rustc", [`+${RUST_TOOLCHAIN}`, "--print", "sysroot"]);
const env = {
  ...process.env,
  RUSTUP_TOOLCHAIN: RUST_TOOLCHAIN,
  CARGO_NET_OFFLINE: "true",
  CARGO_BUILD_JOBS: "1",
  CARGO_TARGET_DIR: process.env.CARGO_TARGET_DIR || join(root, "target"),
  RUSTFLAGS: undefined,
  CARGO_ENCODED_RUSTFLAGS: canonicalBuildFlags({root,cargoHome:process.env.CARGO_HOME || join(homedir(), ".cargo"),sysroot,compilerCommit}),
};
const options = { cwd: root, env };
const tools = {
  rustToolchain: RUST_TOOLCHAIN,
  rustHost,
  walrus: "0.26.4",
  rustc: command("rustc", [`+${RUST_TOOLCHAIN}`, "--version"], options),
  cargo: command("cargo", [`+${RUST_TOOLCHAIN}`, "--version"], options),
  node: process.versions.node,
  wasmPack: command("wasm-pack", ["--version"], options),
  wasmBindgen: command("wasm-bindgen", ["--version"], options),
};
if (tools.wasmPack !== "wasm-pack 0.14.0" || tools.wasmBindgen !== "wasm-bindgen 0.2.127") {
  throw new Error("pinned wasm-pack and wasm-bindgen tools are required");
}
const locks = {};
for (const path of ["Cargo.lock", "castalia-filesystem-wasm/Cargo.lock", "provenance/wasm-bindgen-cli-0.2.127.Cargo.lock"]) {
  locks[path] = digest(await readFile(join(root, path)));
}
for (const manifest of ["Cargo.toml", "castalia-filesystem-wasm/Cargo.toml"]) {
  const metadata = lockedMetadata(join(root, manifest), options);
  for (const item of metadata.packages) {
    if (item.source === null && !["castalia-filesystem-core", "castalia-filesystem-wasm"].includes(item.name)) {
      throw new Error(`unexpected local dependency: ${item.name}`);
    }
    if (item.source !== null && !item.source.startsWith("registry+")) {
      throw new Error(`nonregistry dependency: ${item.name}`);
    }
  }
}
await mkdir(output); // Never overwrite a prior candidate or its acceptance evidence.
for (const [target, folder] of [["web", "web"], ["nodejs", "node"]]) {
  command("wasm-pack", ["build", join(root, "castalia-filesystem-wasm"),
    "--target", target, "--release", "--mode", "no-install", "--no-opt",
    "--out-dir", join(output, folder), "--", "--locked", "--offline"], options);
  const wasm = join(output, folder, "castalia_filesystem_wasm_bg.wasm");
  assertBindingToolProducers(await readFile(wasm));
  await writeFile(wasm, stripWasmNameSection(await readFile(wasm)));
  const packagePath = join(output, folder, "package.json");
  const metadata = JSON.parse(await readFile(packagePath, "utf8"));
  metadata.private = true;
  metadata.castaliaSourceRevision = revision;
  await writeFile(packagePath, `${JSON.stringify(metadata, null, 2)}\n`);
}
console.log(command(process.execPath, [join(root, "castalia-filesystem-wasm/tests/parity.mjs"), join(output, "node")], options));
await copyFile(join(root, "LICENSE"), join(output, "LICENSE"));
await copyFile(join(root, "docs/SNAPSHOT-V1.md"), join(output, "SNAPSHOT-V1.md"));
await mkdir(join(output,"provenance"));
for(const path of ["provenance/build-tools.json","provenance/wasm-bindgen-cli-0.2.127.Cargo.lock"])await copyFile(join(root,path),join(output,path));
for (const [path, expected] of Object.entries(locks)) {
  if (digest(await readFile(join(root, path))) !== expected) throw new Error(`lock changed during build: ${path}`);
}
if (git("rev-parse", "HEAD") !== revision || status() !== initialStatus) {
  throw new Error("source changed during build");
}
const manifest = {
  schema: SCHEMA,
  source: { repository: REPOSITORY, revision, dirty: Boolean(initialStatus), mode: development ? "development" : "candidate" },
  tools,
  locks,
  normalization: "canonical-build-paths-and-remove-only-wasm-name-section",
  files: await inventory(output),
};
const bytes = `${JSON.stringify(manifest, null, 2)}\n`;
await writeFile(join(output, MANIFEST), bytes);
const sha256 = digest(bytes);
await verifyPackage(output, sha256, revision, { development });
console.log(JSON.stringify({ directory: output, sourceRevision: revision, manifestSha256: sha256, files: manifest.files.length }));
