// SPDX-License-Identifier: AGPL-3.0-or-later
import { parseBinding, CatalogError } from "./catalog.mjs";
/** Verified bounded ZIP copy. Source snapshot and source catalog are never modified. */
export async function copyLegacyWorkspace({
  source,
  destination,
  sourceRoot,
  expectedDestinationHead,
  confirmed,
  onProgress,
}) {
  if (
    confirmed !== true ||
    parseBinding(source.binding).kind !== "legacy" ||
    parseBinding(destination.binding).kind !== "workspace"
  )
    throw new CatalogError("invalid");
  const original = await source.catalog();
  if (!original?.revisions.some((item) => item.root === sourceRoot))
    throw new CatalogError("conflict");
  const archive = await source.export(sourceRoot);
  return destination.recover(
    expectedDestinationHead,
    new File([archive], "legacy-workspace.zip", { type: "application/zip" }),
    onProgress,
  );
}
