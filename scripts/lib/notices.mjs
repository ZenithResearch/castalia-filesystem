import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { join } from "node:path";
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const SHA = /^[0-9a-f]{64}$/u;
const PATHS = ["licenses/cargo-runtime-notices.txt", "licenses/rust-standard-library.html"];
// Checks evidence bytes and bindings only. This is not an ownership or legal-clearance decision.
export async function verifyNotices(directory, locks) {
  const read = async path => {
    const stat = await lstat(join(directory,path));
    if(!stat.isFile() || stat.isSymbolicLink() || stat.size > 8*1024*1024) throw new Error("invalid notice file");
    return readFile(join(directory,path));
  };
  const metadata = JSON.parse(await read("provenance/notices.json"));
  if(metadata.schema!=="castalia.filesystem.notices.v1") throw new Error("unsupported notice inventory");
  for(const path of ["castalia-filesystem-wasm/Cargo.lock","provenance/wasm-bindgen-cli-0.2.127.Cargo.lock"])
    if(!SHA.test(metadata.sourceLocks?.[path]) || metadata.sourceLocks[path]!==locks?.[path]) throw new Error("notice dependency lock mismatch");
  if(!Array.isArray(metadata.noticeFiles) || metadata.noticeFiles.length!==PATHS.length) throw new Error("invalid notice files");
  const payloads = new Map();
  for(const item of metadata.noticeFiles) {
    if(!PATHS.includes(item.path) || payloads.has(item.path) || !SHA.test(item.sha256)) throw new Error("invalid notice path or hash");
    const bytes=await read(item.path);
    if(bytes.length!==item.size || hash(bytes)!==item.sha256) throw new Error("notice payload mismatch");
    payloads.set(item.path,bytes);
  }
  if(!Array.isArray(metadata.components) || !metadata.components.length || metadata.components.length>128) throw new Error("invalid notice components");
  const seen=new Set();
  for(const component of metadata.components) {
    const key=`${component.name}@${component.version}`;
    if(typeof component.name!=="string" || typeof component.version!=="string" || seen.has(key) || !["potential-wasm-runtime","generated-binding-source","build-tool-only"].includes(component.role) || typeof component.declaredLicense!=="string" || !component.declaredLicense || !SHA.test(component.registryChecksum) || !Array.isArray(component.notices) || !component.notices.length) throw new Error("invalid notice component");
    seen.add(key);
    for(const notice of component.notices) {
      const bytes=payloads.get(notice.bundlePath);
      if(notice.bundlePath!==PATHS[0] || !bytes || !/^[A-Za-z0-9_.-]+$/u.test(notice.upstreamPath) || !Number.isSafeInteger(notice.offset) || notice.offset<0 || !Number.isSafeInteger(notice.size) || notice.size<1 || notice.offset+notice.size>bytes.length || !SHA.test(notice.sha256) || hash(bytes.subarray(notice.offset,notice.offset+notice.size))!==notice.sha256) throw new Error("notice source slice mismatch");
    }
  }
  const compiler=metadata.compilerRuntime;
  if(!compiler || !/^[0-9a-f]{40}$/u.test(compiler.compilerCommit) || compiler.noticePath!==PATHS[1] || hash(payloads.get(PATHS[1]))!==compiler.sha256) throw new Error("compiler notice mismatch");
  return metadata;
}
