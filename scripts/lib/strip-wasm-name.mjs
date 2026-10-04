/** Drop only the optional WebAssembly `name` custom section. */
export function stripWasmNameSection(input) {
  const bytes = Buffer.from(input);
  if (
    bytes.length < 8 ||
    !bytes.subarray(0, 8).equals(Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]))
  )
    throw new Error("invalid WebAssembly header");

  function unsigned(position) {
    let value = 0;
    let shift = 0;
    for (let index = 0; index < 5; index += 1) {
      if (position >= bytes.length)
        throw new Error("truncated WebAssembly length");
      const octet = bytes[position];
      value += (octet & 0x7f) * 2 ** shift;
      position += 1;
      if ((octet & 0x80) === 0) return { value, position };
      shift += 7;
    }
    throw new Error("oversized WebAssembly length");
  }

  const parts = [bytes.subarray(0, 8)];
  let offset = 8;
  let removed = 0;
  while (offset < bytes.length) {
    const start = offset;
    const kind = bytes[offset++];
    const length = unsigned(offset);
    const end = length.position + length.value;
    if (end > bytes.length) throw new Error("truncated WebAssembly section");
    let isName = false;
    if (kind === 0) {
      const nameLength = unsigned(length.position);
      if (nameLength.position + nameLength.value > end)
        throw new Error("truncated WebAssembly custom section name");
      isName =
        bytes
          .subarray(nameLength.position, nameLength.position + nameLength.value)
          .toString("utf8") === "name";
    }
    if (isName) removed += 1;
    else parts.push(bytes.subarray(start, end));
    offset = end;
  }
  if (removed !== 1)
    throw new Error("expected exactly one WebAssembly name section");
  const output = Buffer.concat(parts);
  if (!WebAssembly.validate(output))
    throw new Error("normalized WebAssembly failed validation");
  return output;
}
