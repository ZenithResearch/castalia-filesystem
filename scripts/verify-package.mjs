import { verifyPackage } from "./lib/package-manifest.mjs";

const [directory, sha256, revision, extra] = process.argv.slice(2);
if (!directory || !sha256 || !revision || extra) {
  throw new Error("usage: verify-package.mjs DIRECTORY MANIFEST_SHA256 SOURCE_COMMIT");
}
const manifest = await verifyPackage(directory, sha256, revision);
console.log(`Verified ${manifest.files.length} package files from ${manifest.source.revision}`);
