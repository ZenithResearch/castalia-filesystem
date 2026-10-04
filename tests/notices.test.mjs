import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verifyNotices } from "../scripts/lib/notices.mjs";
import { noticeFixture } from "./helpers/notice-fixture.mjs";
const locks = {"castalia-filesystem-wasm/Cargo.lock":"c".repeat(64),"provenance/wasm-bindgen-cli-0.2.127.Cargo.lock":"d".repeat(64)};
async function fixture(t){const directory=await mkdtemp(join(tmpdir(),"castalia-notices-"));t.after(()=>rm(directory,{recursive:true,force:true}));return {directory,metadata:await noticeFixture(directory,locks)};}
test("notice inventory binds complete texts and upstream slices to reviewed locks",async t=>{const f=await fixture(t);assert.equal((await verifyNotices(f.directory,locks)).components.length,1);});
test("changed or missing notice payload fails",async t=>{for(const missing of [false,true]){const f=await fixture(t);const path=join(f.directory,"licenses/cargo-runtime-notices.txt");if(missing)await rm(path);else await writeFile(path,"different notice");await assert.rejects(verifyNotices(f.directory,locks));}});
test("unknown inventory, unsafe paths, duplicate components and altered slices fail",async t=>{for(const mutate of [m=>{m.schema="future";},m=>{m.noticeFiles[0].path="../outside";},m=>{m.components.push(m.components[0]);},m=>{m.components[0].notices[0].offset=1;},m=>{m.components[0].role="ownership-cleared";}]){const f=await fixture(t);mutate(f.metadata);await writeFile(join(f.directory,"provenance/notices.json"),JSON.stringify(f.metadata));await assert.rejects(verifyNotices(f.directory,locks));}});
test("notice evidence from a different dependency lock is rejected",async t=>{const f=await fixture(t);await assert.rejects(verifyNotices(f.directory,{...locks,"castalia-filesystem-wasm/Cargo.lock":"e".repeat(64)}),/lock/);});
