// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  ShippingError,
  canonicalJson,
  hexId,
  SHIPPING_LIMITS,
  exactObject,
} from "./shipping-contract.mjs";
const encoder = new TextEncoder(),
  decoder = new TextDecoder("utf-8", { fatal: true });
const MAGIC = encoder.encode("CFSHIP1\0");
const FILE_LIMIT = 32 * 1024 * 1024;
function path(value) {
  if (
    typeof value !== "string" ||
    value.length > 4096 ||
    !value.startsWith("/") ||
    value === "/" ||
    value
      .split("/")
      .slice(1)
      .some((x) => !x || x === "." || x === ".." || x.includes("\0"))
  )
    throw new ShippingError("invalid");
  return value;
}
export function packShipment(header, objects) {
  const bytes = encoder.encode(canonicalJson(header));
  if (bytes.length > SHIPPING_LIMITS.headerBytes)
    throw new ShippingError("limit");
  const prefix = new Uint8Array(12);
  prefix.set(MAGIC);
  new DataView(prefix.buffer).setUint32(8, bytes.length, false);
  const blob = new Blob([prefix, bytes, ...objects]);
  if (blob.size > SHIPPING_LIMITS.plaintextBytes)
    throw new ShippingError("limit");
  return blob;
}
export async function unpackShipment(blob, contentId) {
  if (
    !(blob instanceof Blob) ||
    blob.size < 12 ||
    blob.size > SHIPPING_LIMITS.plaintextBytes
  )
    throw new ShippingError("limit");
  const bytes = new Uint8Array(await blob.arrayBuffer());
  if (MAGIC.some((b, i) => bytes[i] !== b))
    throw new ShippingError("unsupported-version");
  const size = new DataView(bytes.buffer).getUint32(8, false);
  if (size > SHIPPING_LIMITS.headerBytes || 12 + size > bytes.length)
    throw new ShippingError("limit");
  let header;
  try {
    header = JSON.parse(decoder.decode(bytes.subarray(12, 12 + size)));
  } catch {
    throw new ShippingError("invalid");
  }
  exactObject(header, [
    "schema",
    "kind",
    "sourceRoot",
    "sourcePath",
    "fileMetadata",
    "objects",
  ]);
  if (
    header.schema !== "castalia.files-shipment.v1" ||
    !["workspace", "file"].includes(header.kind)
  )
    throw new ShippingError("unsupported-version");
  hexId(header.sourceRoot);
  if (header.kind === "file") {
    path(header.sourcePath);
    exactObject(header.fileMetadata, ["modifiedMs", "executable"]);
    if (
      !Number.isSafeInteger(header.fileMetadata.modifiedMs) ||
      header.fileMetadata.modifiedMs < 0 ||
      typeof header.fileMetadata.executable !== "boolean"
    )
      throw new ShippingError("invalid");
  } else if (header.sourcePath !== null || header.fileMetadata !== null)
    throw new ShippingError("invalid");
  if (
    !Array.isArray(header.objects) ||
    header.objects.length < 1 ||
    header.objects.length > SHIPPING_LIMITS.objects ||
    (header.kind === "file" && header.objects.length !== 1)
  )
    throw new ShippingError("limit");
  const objects = new Map();
  let offset = 12 + size,
    previous = "";
  for (const item of header.objects) {
    exactObject(item, ["id", "length"]);
    hexId(item.id);
    if (
      item.id <= previous ||
      !Number.isSafeInteger(item.length) ||
      item.length < 0 ||
      item.length > (header.kind === "file" ? FILE_LIMIT : 4 * 1024 * 1024) ||
      offset + item.length > bytes.length
    )
      throw new ShippingError("invalid");
    const data = bytes.subarray(offset, offset + item.length);
    if (contentId(data) !== item.id) throw new ShippingError("integrity");
    objects.set(item.id, data);
    offset += item.length;
    previous = item.id;
  }
  if (offset !== bytes.length) throw new ShippingError("invalid");
  return { header, objects };
}
export async function captureShipment(fs, wasm, root, sourcePath) {
  hexId(root);
  if (sourcePath !== undefined && sourcePath !== null) {
    path(sourcePath);
    const stat = JSON.parse(await fs.reader.stat(root, sourcePath));
    if (
      stat.kind !== "file" ||
      !Number.isSafeInteger(stat.body.size) ||
      stat.body.size < 0 ||
      stat.body.size > FILE_LIMIT
    )
      throw new ShippingError("limit");
    const data = new Uint8Array(stat.body.size);
    for (let offset = 0; offset < data.length; offset += 1024 * 1024) {
      const bytes = await fs.reader.read_range(
        root,
        sourcePath,
        BigInt(offset),
        Math.min(1024 * 1024, data.length - offset),
      );
      if (bytes.length !== Math.min(1024 * 1024, data.length - offset))
        throw new ShippingError("integrity");
      data.set(bytes, offset);
    }
    const header = {
      schema: "castalia.files-shipment.v1",
      kind: "file",
      sourceRoot: root,
      sourcePath,
      fileMetadata: {
        modifiedMs: stat.body.modified_ms,
        executable: stat.body.executable,
      },
      objects: [{ id: wasm.content_id(data), length: data.length }],
    };
    return packShipment(header, [data]);
  }
  await fs.reader.validate_tree_bounded(root, 100n * 1024n * 1024n);
  const ids = JSON.parse(
    await fs.reader.reachable_ids_bounded(
      root,
      SHIPPING_LIMITS.objects,
      256n * 1024n * 1024n,
    ),
  ).sort();
  const data = [],
    objects = [];
  let total = 0;
  for (const id of ids) {
    const bytes = await fs.get(id, 4 * 1024 * 1024);
    if (wasm.content_id(bytes) !== id) throw new ShippingError("integrity");
    total += bytes.length;
    if (total > SHIPPING_LIMITS.plaintextBytes - SHIPPING_LIMITS.headerBytes)
      throw new ShippingError("limit");
    data.push(bytes);
    objects.push({ id, length: bytes.length });
  }
  return packShipment(
    {
      schema: "castalia.files-shipment.v1",
      kind: "workspace",
      sourceRoot: root,
      sourcePath: null,
      fileMetadata: null,
      objects,
    },
    data,
  );
}
export async function verifyShipmentArchive(blob, wasm) {
  const unpacked = await unpackShipment(blob, wasm.content_id);
  if (unpacked.header.kind === "workspace") {
    const reader = new wasm.PinnedSnapshotReader(async (id, maxBytes) => {
      const value = unpacked.objects.get(id);
      if (!value) throw new ShippingError("missing-object");
      if (value.length > maxBytes) throw new ShippingError("limit");
      return value;
    });
    try {
      await reader.validate_tree_bounded(
        unpacked.header.sourceRoot,
        100n * 1024n * 1024n,
      );
      const ids = JSON.parse(
        await reader.reachable_ids_bounded(
          unpacked.header.sourceRoot,
          SHIPPING_LIMITS.objects,
          256n * 1024n * 1024n,
        ),
      );
      if (
        ids.length !== unpacked.objects.size ||
        ids.some((id) => !unpacked.objects.has(id))
      )
        throw new ShippingError("invalid");
    } finally {
      reader.free();
    }
  }
  return unpacked;
}
export async function restoreShipmentArchive(blob, wasm, fs, binding, now) {
  const { header, objects } = await verifyShipmentArchive(blob, wasm);
  if (header.kind === "workspace") {
    if (binding.kind === "workspace") {
      const raw = JSON.parse(decoder.decode(objects.get(header.sourceRoot)));
      if (
        raw.node?.kind !== "snapshot" ||
        raw.node.body?.namespace !== binding.namespaceId
      )
        throw new ShippingError(
          "namespace-mismatch",
          "Copy explicitly; snapshot namespace cannot be reinterpreted",
        );
    }
    for (const [id, bytes] of objects) {
      if ((await fs.put(bytes)) !== id) throw new ShippingError("integrity");
    }
    return header.sourceRoot;
  }
  const namespace =
    binding.kind === "workspace"
      ? binding.namespaceId
      : wasm.content_id(crypto.getRandomValues(new Uint8Array(32)));
  const builder = new wasm.BrowserSnapshotBuilder(
    namespace,
    BigInt(now),
    fs.put,
  );
  try {
    const name = header.sourcePath.split("/").at(-1);
    builder.begin_file(
      "/" + name,
      BigInt(header.fileMetadata.modifiedMs),
      header.fileMetadata.executable,
    );
    const bytes = objects.values().next().value;
    for (let i = 0; i < bytes.length; i += 1024 * 1024)
      await builder.append_chunk(bytes.subarray(i, i + 1024 * 1024));
    builder.finish_file();
    return await builder.finish();
  } finally {
    builder.free();
  }
}
