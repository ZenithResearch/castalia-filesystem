// SPDX-License-Identifier: AGPL-3.0-or-later
export class RegistrationError extends Error {
  constructor(code, message = code) {
    super(message);
    this.name = "RegistrationError";
    this.code = code;
  }
}
export function exact(value, keys, label = "record") {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(",") !== [...keys].sort().join(",")
  )
    throw new RegistrationError("invalid", `Invalid ${label} fields`);
}
export function hex32(value, label = "identifier") {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/u.test(value))
    throw new RegistrationError("invalid", `Invalid ${label}`);
  return value;
}
export function parseAddress(value) {
  exact(value, ["namespaceId", "workspaceId"], "workspace address");
  return Object.freeze({
    namespaceId: hex32(value.namespaceId),
    workspaceId: hex32(value.workspaceId),
  });
}
export function addressKey(value) {
  const a = parseAddress(value);
  return `${a.namespaceId}:${a.workspaceId}`;
}
export function workspaceKey(value) {
  const a = parseAddress(value);
  return ["workspace-v1", a.namespaceId, a.workspaceId];
}
export function registrationKey(namespaceId) {
  return ["registration-v1", hex32(namespaceId)];
}
export function entityKey(entityRef) {
  if (
    typeof entityRef !== "string" ||
    !/^urn:castalia:entity:[0-9a-f]{64}$/u.test(entityRef)
  )
    throw new RegistrationError("invalid", "Invalid entity reference");
  return ["entity-namespace-v1", entityRef];
}
