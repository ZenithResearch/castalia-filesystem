import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import ts from "typescript";
const root = new URL("../src/", import.meta.url);
test("shared browser adapter imports only its local modules and pinned ZIP and has no egress primitives", () => {
  const violations = [];
  for (const name of readdirSync(root).filter((name) =>
    name.endsWith(".mjs"),
  )) {
    const source = ts.createSourceFile(
      name,
      readFileSync(new URL(name, root), "utf8"),
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.JS,
    );
    const visit = (node) => {
      if (
        (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
        node.moduleSpecifier &&
        ts.isStringLiteral(node.moduleSpecifier)
      ) {
        const text = node.moduleSpecifier.text;
        if (
          !text.startsWith("./") &&
          text !== "@zip.js/zip.js/lib/zip-core-native.js"
        )
          violations.push(name + ":import " + text);
      }
      if (ts.isCallExpression(node)) {
        if (node.expression.kind === ts.SyntaxKind.ImportKeyword)
          violations.push(name + ":dynamic import");
        const call = node.expression;
        const method = ts.isIdentifier(call)
          ? call.text
          : ts.isPropertyAccessExpression(call)
            ? call.name.text
            : "";
        if (
          ["fetch", "sendBeacon", "importScripts", "require"].includes(method)
        )
          violations.push(name + ":" + method);
      }
      if (
        ts.isNewExpression(node) &&
        ts.isIdentifier(node.expression) &&
        [
          "XMLHttpRequest",
          "WebSocket",
          "EventSource",
          "WebTransport",
          "RTCPeerConnection",
        ].includes(node.expression.text)
      )
        violations.push(name + ":network constructor");
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  assert.deepEqual(violations, []);
});
