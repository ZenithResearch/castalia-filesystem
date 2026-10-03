import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
const root = new URL("../",import.meta.url);
test("supplemental origin evidence matches exact destination bytes without claiming permission", async()=>{
 const metadata=JSON.parse(await readFile(new URL("provenance/browser-supplemental-origins.json",root),"utf8"));
 assert.equal(metadata.schema,"castalia.browser-supplemental-origins.v1");
 assert.equal(metadata.inspectedDestinationRevision,"d535c5e79b66c66f7cd04d33544921d5a8c13b09");
 assert.equal(metadata.records.length,7);
 const adaptations=JSON.parse(await readFile(new URL("provenance/private-shipping.json",root),"utf8")).adaptations;
 const seen=new Set();
 for(const item of metadata.records){
  assert.equal(item.inference,true);assert.equal(item.comparisonStatus,"documented");assert.equal(item.derivationStatus,"unresolved");assert.equal(item.permissionStatus,"unresolved");
  const path=item.destination.path;assert.match(path,/^(?:packages\/browser\/src|packages\/browser\/tests)\/[a-z0-9.-]+$/u);assert.equal(seen.has(path),false);seen.add(path);
  const bytes=await readFile(new URL(path,root));
  const change=adaptations.find(value=>value.path===path);
  if(change){assert.equal(change.previousSha256,item.destination.sha256);assert.equal(change.sourcePermission,"unresolved; no new grant inferred");assert.ok(change.change.length>20);}
  assert.equal(createHash("sha256").update(bytes).digest("hex"),change?.currentSha256??item.destination.sha256,path);
 }
});
