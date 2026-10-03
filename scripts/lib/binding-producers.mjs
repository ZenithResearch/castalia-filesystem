/** Inspect preserved producer metadata; never rewrite executable exports or producers. */
export function assertBindingToolProducers(bytes) {
  const sections=WebAssembly.Module.customSections(new WebAssembly.Module(bytes),'producers');
  if(sections.length!==1) throw new Error('expected one producers section');
  const data=new Uint8Array(sections[0]);let offset=0;
  function number(){let value=0;for(let n=0;n<5;n++){if(offset>=data.length)throw new Error('truncated producers');const byte=data[offset++];value+=(byte&127)*2**(7*n);if(!(byte&128))return value;}throw new Error('invalid producers length');}
  function string(){const length=number();if(length>data.length-offset)throw new Error('truncated producer string');const value=new TextDecoder('utf8',{fatal:true}).decode(data.subarray(offset,offset+length));offset+=length;return value;}
  const fields=new Map();for(let n=number();n>0;n--){const field=string();if(fields.has(field))throw new Error('duplicate producer field');const values=new Map();for(let count=number();count>0;count--){const key=string(),value=string();if(values.has(key))throw new Error('duplicate producer');values.set(key,value);}fields.set(field,values);}
  if(offset!==data.length)throw new Error('trailing producer metadata');
  const processors=fields.get('processed-by');
  if(processors?.get('walrus')!=='0.26.4'||processors?.get('wasm-bindgen')!=='0.2.127') throw new Error('binding tool must be wasm-bindgen 0.2.127 built with its published --locked dependencies (walrus 0.26.4)');
}
