export * from "./registration-store.mjs";
export {
  DATABASE,
  DATABASE_VERSION,
  WORKSPACES,
  parseAddress,
  addressKey,
  workspaceKey,
  openDatabase,
  atomic,
} from "./database.mjs";
import type {
  WorkspaceAddress,
  NamespaceBinding,
  WorkspaceCatalog,
} from "./registration-store.mjs";
export type FilesystemBinding = Readonly<
  | { kind: "legacy" }
  | ({ kind: "workspace" } & WorkspaceAddress & NamespaceBinding)
>;
export interface FilesystemProgress {
  completed: number;
  total: number;
  expandedBytes: number;
}
export interface FilesystemClient {
  readonly binding: FilesystemBinding;
  readonly ready: Promise<unknown>;
  load(): Promise<WorkspaceCatalog | null>;
  catalog(): Promise<WorkspaceCatalog | null>;
  import(
    file: File,
    onProgress?: (progress: FilesystemProgress) => void,
  ): Promise<WorkspaceCatalog>;
  recover(
    expectedHead: string | null,
    file: File,
    onProgress?: (progress: FilesystemProgress) => void,
  ): Promise<WorkspaceCatalog>;
  recoverInvalid(
    file: File,
    onProgress?: (progress: FilesystemProgress) => void,
  ): Promise<WorkspaceCatalog>;
  reclaim(): Promise<{ objects: number; bytes: number }>;
  cancelImport(): void;
  list(root: string, path: string): Promise<DirectoryEntry[]>;
  stat(root: string, path: string): Promise<SnapshotNode>;
  read(
    root: string,
    path: string,
    offset: number,
    length: number,
  ): Promise<Uint8Array>;
  revise(
    expectedRoot: string,
    path: string,
    file: File,
  ): Promise<WorkspaceCatalog>;
  export(root: string): Promise<Blob>;
  destroy(): void;
}
export interface DirectoryEntry {
  name: string;
  node: { inode: number; kind: "directory" | "file"; manifest: string };
}
export interface SnapshotNode {
  kind: "file" | "directory";
  body: {
    inode: number;
    modified_ms: number;
    size?: number;
    executable?: boolean;
  };
}
export type FileEntry = DirectoryEntry;
export type FileNode = SnapshotNode;
export type ZipImportProgress = FilesystemProgress;
export interface SnapshotReader {
  validate_tree(root: string): Promise<void>;
  validate_tree_bounded(root: string, limit: bigint): Promise<void>;
  reachable_ids_bounded(
    root: string,
    count: number,
    limit: bigint,
  ): Promise<string>;
  list(root: string, path: string): Promise<string>;
  stat(root: string, path: string): Promise<string>;
  read_range(
    root: string,
    path: string,
    offset: bigint,
    length: number,
  ): Promise<Uint8Array>;
  free(): void;
}
export interface FilesystemWasm {
  content_id(bytes: Uint8Array): string;
  PinnedSnapshotReader: new (
    get: (id: string, maxBytes: number) => Promise<Uint8Array>,
  ) => SnapshotReader;
  BrowserSnapshotBuilder: new (
    namespace: string,
    time: bigint,
    put: (bytes: Uint8Array) => Promise<string>,
  ) => {
    add_directory(path: string, time: bigint): void;
    begin_file(path: string, time: bigint, executable: boolean): void;
    append_chunk(bytes: Uint8Array): Promise<void>;
    finish_file(): void;
    finish(): Promise<string>;
    free(): void;
  };
  BrowserFileRevision: new (
    root: string,
    path: string,
    time: bigint,
    executable: boolean,
    get: (id: string, maxBytes: number) => Promise<Uint8Array>,
    put: (bytes: Uint8Array) => Promise<string>,
  ) => {
    append_chunk(bytes: Uint8Array): Promise<void>;
    finish(): Promise<string>;
    free(): void;
  };
}
export interface RuntimeOptions {
  binding: FilesystemBinding;
  wasm: FilesystemWasm;
  storage?: Pick<StorageManager, "getDirectory">;
  locks?: Pick<LockManager, "request">;
  indexedDB?: IDBFactory;
  assertMount?: (
    binding: Extract<FilesystemBinding, { kind: "workspace" }>,
    db: IDBDatabase,
  ) => Promise<unknown>;
  progress?: (message: { id: number; progress: FilesystemProgress }) => void;
  now?: () => number;
  random?: Pick<Crypto, "getRandomValues">;
}
export interface FilesystemRuntime {
  readonly binding: FilesystemBinding;
  execute(
    request: { operation: string; [key: string]: unknown },
    signal?: AbortSignal,
  ): Promise<unknown>;
  dispose(): Promise<void>;
}
export function createFilesystemRuntime(
  options: RuntimeOptions,
): FilesystemRuntime;
export function createFilesystemClient(
  worker: Worker,
  binding: FilesystemBinding,
): FilesystemClient;
export function stageInitialWorkspace(options: {
  address: WorkspaceAddress;
  wasm: FilesystemWasm;
  storage?: Pick<StorageManager, "getDirectory">;
  locks?: Pick<LockManager, "request">;
  indexedDB?: IDBFactory;
  now?: () => number;
}): Promise<WorkspaceCatalog>;
export function copyLegacyWorkspace(options: {
  source: FilesystemClient;
  destination: FilesystemClient;
  sourceRoot: string;
  expectedDestinationHead: string | null;
  confirmed: boolean;
  onProgress?: (progress: FilesystemProgress) => void;
}): Promise<WorkspaceCatalog>;
export interface Catalog {
  readonly binding: FilesystemBinding;
  load(): Promise<WorkspaceCatalog | null>;
  commitRoot(
    expectedHead: string | null,
    nextRoot: string,
    committedMs: number,
  ): Promise<WorkspaceCatalog>;
  recoverInvalid(
    nextRoot: string,
    committedMs: number,
  ): Promise<WorkspaceCatalog>;
}
export class CatalogError extends Error {
  readonly code: string;
}
export class FilesystemClientError extends Error {
  readonly code: string;
}
export function createCatalog(
  binding: FilesystemBinding,
  options?: { indexedDB?: IDBFactory },
): Catalog;
export function createLegacyCatalog(options?: {
  indexedDB?: IDBFactory;
}): Catalog;
export function createWorkspaceCatalog(
  binding: WorkspaceAddress & NamespaceBinding,
  options?: { indexedDB?: IDBFactory },
): Catalog;
export function parseWorkspaceCatalog(value: unknown): WorkspaceCatalog;
export function parseBinding(value: unknown): FilesystemBinding;
export function bindingKey(value: FilesystemBinding): string;
export function mutationLockName(value: FilesystemBinding): string;
export function openWorkspaceRoot(
  storage: Pick<StorageManager, "getDirectory">,
  binding: FilesystemBinding,
): Promise<FileSystemDirectoryHandle>;
