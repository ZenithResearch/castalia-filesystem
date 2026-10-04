import test from 'node:test';import assert from 'node:assert/strict';import {assertBindingToolProducers} from '../scripts/lib/binding-producers.mjs';
const str=value=>[value.length,...Buffer.from(value)];
function fixture(walrus){const payload=[...str('producers'),1,...str('processed-by'),2,...str('walrus'),...str(walrus),...str('wasm-bindgen'),...str('0.2.127')];return Uint8Array.from([0,97,115,109,1,0,0,0,0,payload.length,...payload]);}
test('published locked binding processor versions are inspected without modifying bytes',()=>{const bytes=fixture('0.26.4'),copy=bytes.slice();assertBindingToolProducers(bytes);assert.deepEqual(bytes,copy);});
test('same CLI version with an unlocked walrus dependency is rejected',()=>{assert.throws(()=>assertBindingToolProducers(fixture('0.26.5')),/published --locked/);assert.throws(()=>assertBindingToolProducers(Uint8Array.from([0,97,115,109,1,0,0,0])),/producers/);});
