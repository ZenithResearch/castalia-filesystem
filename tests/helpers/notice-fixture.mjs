import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
export async function noticeFixture(directory, locks) {
  await mkdir(join(directory, "licenses"), {recursive:true});
  await mkdir(join(directory, "provenance"), {recursive:true});
  const bundle = Buffer.from("synthetic crate notice");
  const compiler = Buffer.from("synthetic compiler copyright report");
  await writeFile(join(directory,"licenses/cargo-runtime-notices.txt"),bundle);
  await writeFile(join(directory,"licenses/rust-standard-library.html"),compiler);
  const metadata = {
    schema:"castalia.filesystem.notices.v1",
    sourceLocks: {
      "castalia-filesystem-wasm/Cargo.lock":locks["castalia-filesystem-wasm/Cargo.lock"],
      "provenance/wasm-bindgen-cli-0.2.127.Cargo.lock":locks["provenance/wasm-bindgen-cli-0.2.127.Cargo.lock"],
    },
    components:[{name:"fixture",version:"1.0.0",role:"potential-wasm-runtime",declaredLicense:"MIT",registryChecksum:"a".repeat(64),notices:[{upstreamPath:"LICENSE",bundlePath:"licenses/cargo-runtime-notices.txt",offset:0,size:bundle.length,sha256:hash(bundle)}]}],
    compilerRuntime:{compilerCommit:"b".repeat(40),noticePath:"licenses/rust-standard-library.html",sha256:hash(compiler)},
    noticeFiles:[{path:"licenses/cargo-runtime-notices.txt",size:bundle.length,sha256:hash(bundle)},{path:"licenses/rust-standard-library.html",size:compiler.length,sha256:hash(compiler)}],
  };
  await writeFile(join(directory,"provenance/notices.json"),JSON.stringify(metadata));
  return metadata;
}
