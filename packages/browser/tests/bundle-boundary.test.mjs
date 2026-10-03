import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";

async function bundledModules(t, names) {
  const directory = await mkdtemp(join(tmpdir(), "filesystem-bundle-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const entry = join(directory, "entry.mjs");
  const source = fileURLToPath(new URL("../src/index.mjs", import.meta.url));
  await writeFile(
    entry,
    `export { ${names.join(", ")} } from ${JSON.stringify(source)};`,
  );
  const result = await build({
    configFile: false,
    logLevel: "silent",
    build: {
      write: false,
      minify: false,
      lib: { entry, formats: ["es"] },
    },
  });
  return (Array.isArray(result) ? result : [result])
    .flatMap((build) => build.output)
    .flatMap((chunk) =>
      chunk.type === "chunk"
        ? Object.entries(chunk.modules)
            .filter(([, info]) => info.renderedLength > 0)
            .map(([id]) => id)
        : [],
    );
}

test("client and initial staging imports do not pull ZIP worker code into the main bundle", async (t) => {
  const modules = await bundledModules(t, [
    "createFilesystemClient",
    "stageInitialWorkspace",
    "copyLegacyWorkspace",
  ]);
  assert.ok(modules.some((id) => id.endsWith("filesystem-client.mjs")));
  assert.ok(!modules.some((id) => id.includes("@zip.js")));
  assert.ok(!modules.some((id) => id.endsWith("runtime.mjs")));
});

test("explicit runtime imports retain required ZIP implementation", async (t) => {
  const modules = await bundledModules(t, ["createFilesystemRuntime"]);
  assert.ok(modules.some((id) => id.endsWith("runtime.mjs")));
  assert.ok(modules.some((id) => id.includes("@zip.js")));
});
