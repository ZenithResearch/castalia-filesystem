// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  readFileSync,
  mkdtempSync,
  writeFileSync,
  chmodSync,
  lstatSync,
  openSync,
  readSync,
  closeSync,
  constants,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { spawnSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
export const release = JSON.parse(
  readFileSync(new URL("../s3d-release.json", import.meta.url), "utf8"),
);
export function verifyReleaseArchive(
  bytes,
  { platform = process.platform, arch = process.arch } = {},
) {
  const asset = release.assets.find(
    (v) => v.platform === platform && v.arch === arch,
  );
  if (!asset) throw new Error("Unsupported official s3d platform");
  if (
    bytes.length !== asset.size ||
    createHash("sha256").update(bytes).digest("hex") !== asset.sha256
  )
    throw new Error("Official s3d release checksum mismatch");
  return asset;
}
export function readArchive(path) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const s = lstatSync(path);
    if (!s.isFile() || s.size > 16 * 1024 * 1024)
      throw new Error("Invalid s3d archive");
    const bytes = Buffer.alloc(s.size);
    let offset = 0;
    while (offset < bytes.length) {
      const n = readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (!n) throw new Error("Truncated s3d archive");
      offset += n;
    }
    return bytes;
  } finally {
    closeSync(fd);
  }
}
export function prepareExecutable(bytes, options) {
  const asset = verifyReleaseArchive(bytes, options);
  const directory = mkdtempSync(join(tmpdir(), "castalia-verified-s3d-"));
  chmodSync(directory, 0o700);
  const archive = join(directory, "release.zip");
  writeFileSync(archive, bytes, { mode: 0o400, flag: "wx" });
  const listing = spawnSync("/usr/bin/unzip", ["-Z1", archive], {
    encoding: "utf8",
    maxBuffer: 65536,
  });
  if (listing.status !== 0)
    throw new Error("Cannot inspect verified release ZIP");
  const entry = listing.stdout
    .trim()
    .split("\n")
    .find((v) => /^(?:[^/]+\/)?s3d$/.test(v));
  if (!entry)
    throw new Error("Verified release has no supported executable entry");
  const extracted = spawnSync("/usr/bin/unzip", ["-p", archive, entry], {
    maxBuffer: 64 * 1024 * 1024,
  });
  if (extracted.status !== 0 || !extracted.stdout.length)
    throw new Error("Cannot extract verified s3d release");
  const executable = join(directory, "s3d");
  writeFileSync(executable, extracted.stdout, { mode: 0o500, flag: "wx" });
  return {
    executable,
    archiveSha256: asset.sha256,
    executableSha256: createHash("sha256")
      .update(extracted.stdout)
      .digest("hex"),
    revision: release.revision,
  };
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  if (process.version !== "v24.18.0") throw new Error("Use Node 24.18.0");
  process.umask(0o077);
  const [archive, mode, ...args] = process.argv.slice(2);
  if (!archive || !["--verify-only", "--run"].includes(mode))
    throw new Error(
      "Usage: node s3d-launcher.mjs official-release.zip --verify-only|--run [s3d arguments]",
    );
  const bytes = readArchive(archive);
  const prepared = prepareExecutable(bytes);
  console.log(
    JSON.stringify({
      archiveSha256: prepared.archiveSha256,
      executableSha256: prepared.executableSha256,
      revision: prepared.revision,
    }),
  );
  if (mode === "--run") {
    const version = spawnSync(prepared.executable, ["version"], {
      encoding: "utf8",
      maxBuffer: 65536,
    });
    if (
      version.status !== 0 ||
      !/^s3d v?0\.2\.0$/m.test(version.stdout) ||
      !release.revision.startsWith(
        version.stdout.match(/^Commit: ([0-9a-f]{7,40})$/m)?.[1] ?? "invalid",
      )
    )
      throw new Error("Verified s3d executable reports an unexpected build");
    const child = spawn(prepared.executable, args, { stdio: "inherit" });
    for (const signal of ["SIGINT", "SIGTERM"])
      process.once(signal, () => child.kill(signal));
    child.once("exit", (code) => process.exit(code ?? 1));
  }
}
