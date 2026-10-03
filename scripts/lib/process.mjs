import { execFileSync } from "node:child_process";

export const RUST_TOOLCHAIN = "nightly-2026-06-21";
export const NODE_VERSION = "24.18.0";

export function command(program, args, options = {}) {
  return execFileSync(program, args, {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    ...options,
  }).trim();
}

// Run before wasm-pack: its metadata phase otherwise repairs missing/stale locks.
export function lockedMetadata(manifest, options = {}) {
  return JSON.parse(command("cargo", [
    `+${RUST_TOOLCHAIN}`, "metadata", "--manifest-path", manifest,
    "--format-version", "1", "--locked", "--offline",
  ], options));
}
