import test from 'node:test';
import assert from 'node:assert/strict';
import {Worker} from 'node:worker_threads';
import {createShippingCryptoClient} from '../src/shipping-worker.mjs';
const binding={schema:'castalia.files-key-binding.v1',ownerMemberKey:'1'.repeat(64),serviceId:'2'.repeat(64),storageAccountId:'synthetic',namespaceId:'3'.repeat(64),workspaceId:'4'.repeat(64),submissionId:'5'.repeat(64),revisionId:'6'.repeat(64)};
function worker(){
 const url=new URL('../src/shipping-worker.mjs',import.meta.url).href;
 const source=`import {parentPort} from 'node:worker_threads';import {installShippingCryptoWorker} from ${JSON.stringify(url)};const handlers=new Map();installShippingCryptoWorker({addEventListener(_type,fn){const h=data=>fn({data});handlers.set(fn,h);parentPort.on('message',h)},removeEventListener(_type,fn){parentPort.off('message',handlers.get(fn))},postMessage(value,transfer){parentPort.postMessage(value,transfer)}});`;
 const native=new Worker(new URL('data:text/javascript,'+encodeURIComponent(source)),{type:'module'}),listeners=new Map();
 return {addEventListener(type,fn){const h=data=>fn(type==='message'?{data}:data);listeners.set(fn,h);native.on(type,h);},removeEventListener(type,fn){native.off(type,listeners.get(fn));listeners.delete(fn);},postMessage:(...args)=>native.postMessage(...args),terminate:()=>native.terminate()};
}
test('real worker: transfer-only keys, authenticated encryption and disposal',async()=>{
 const client=createShippingCryptoClient(worker()),key=crypto.getRandomValues(new Uint8Array(32)),copy=key.slice(),plain=new TextEncoder().encode('private bytes');
 try{const encrypted=await client.encrypt(plain,key,binding);assert.equal(key.byteLength,0);assert.equal(plain.byteLength,0);const clear=await client.decrypt(encrypted.ciphertext,copy,binding,encrypted.nonce);assert.equal(new TextDecoder().decode(clear),'private bytes');assert.equal(copy.byteLength,0);client.dispose();await assert.rejects(client.encrypt(new Uint8Array(1),new Uint8Array(32),binding),{code:'worker-unavailable'});}finally{client.dispose();}
});
test('real worker: cancellation rejects before late decryption can return bytes',async()=>{
 const client=createShippingCryptoClient(worker()),abort=new AbortController(),key=new Uint8Array(32),promise=client.encrypt(new Uint8Array(16*1024*1024),key,binding,abort.signal);abort.abort();
 try{await assert.rejects(promise,{code:'cancelled'});assert.equal(key.byteLength,0);}finally{client.dispose();}
});
test('worker loss rejects pending requests and clears lifecycle handlers',async()=>{
 const client=createShippingCryptoClient(worker()),promise=client.encrypt(new Uint8Array(32),new Uint8Array(32),binding);client.dispose();await assert.rejects(promise,{code:'worker-unavailable'});
});
