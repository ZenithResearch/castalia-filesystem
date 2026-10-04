/** Remap compiler inputs rather than rewriting executable bytes or symbol hashes. */
export function canonicalBuildFlags({root,cargoHome,sysroot,compilerCommit}) {
  if(!/^[0-9a-f]{40}$/u.test(compilerCommit)) throw new Error('invalid compiler source revision');
  const mappings=[[root,'/castalia-source'],[cargoHome,'/castalia-cargo'],[`${sysroot}/lib/rustlib/src/rust`,`/rustc/${compilerCommit}`]];
  if(mappings.some(([path])=>typeof path!=='string'||!path.startsWith('/')||/[\u0000\u001f]/u.test(path))) throw new Error('invalid build source path');
  return mappings.map(([from,to])=>`--remap-path-prefix=${from}=${to}`).join('\u001f');
}
