export interface WorkspaceAddress {
  namespaceId: string;
  workspaceId: string;
}
export const DATABASE: "castalia-browser-filesystem";
export const DATABASE_VERSION: 2;
export const WORKSPACES: "catalog";
export function parseAddress(value: unknown): Readonly<WorkspaceAddress>;
export function addressKey(value: unknown): string;
export function workspaceKey(value: unknown): ["workspace-v1", string, string];
export function openDatabase(factory?: IDBFactory): Promise<IDBDatabase>;
export function atomic<T>(
  db: IDBDatabase,
  mode: IDBTransactionMode,
  callback: (
    store: IDBObjectStore,
    done: (value: T) => void,
    abort: (error: unknown) => void,
  ) => void,
): Promise<T>;
