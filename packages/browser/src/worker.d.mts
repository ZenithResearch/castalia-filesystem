import type { RuntimeOptions, FilesystemWasm } from "./index.mjs";
export function installFilesystemWorker(
  port: Pick<
    Worker,
    "addEventListener" | "removeEventListener" | "postMessage"
  >,
  options: Omit<RuntimeOptions, "binding" | "progress" | "wasm"> & {
    wasm:
      | FilesystemWasm
      | Promise<FilesystemWasm>
      | (() => Promise<FilesystemWasm>);
  },
): () => Promise<void>;
