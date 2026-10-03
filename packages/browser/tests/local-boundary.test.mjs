import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import ts from "typescript";
const root = new URL("../src/", import.meta.url);
test("local filesystem entrypoints retain zero egress; only the explicit shipping entrypoint may fetch", () => {
  const violations = [];
  const imports = new Map();
  let shippingFetches=0;
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
        if(text.startsWith("./"))imports.set(name,[...(imports.get(name)??[]),text.slice(2)]);
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
          if(name==="shipping.mjs" && method==="fetch") shippingFetches++;
          else violations.push(name + ":" + method);
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
  // Runtime/custody/storage imports stay local even when a shipping journal exists.
  const visited=new Set();
  function walk(name){if(visited.has(name))return;visited.add(name);assert.notEqual(name,"shipping.mjs");for(const child of imports.get(name)??[])walk(child);}
  for(const name of ["index.mjs","worker.mjs","registration.mjs"])walk(name);
  assert.equal(shippingFetches,1);
});
