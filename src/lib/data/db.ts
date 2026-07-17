/**
 * Local persistence: a thin promise wrapper over IndexedDB.
 * Holds synced account entities, the change cursor, and the offline
 * mutation queue so the app opens instantly and works through network gaps.
 */

const DB_NAME = "juno";
const DB_VERSION = 2;

export const STORES = [
  "conversations",
  "messages", // keyed `${conversationId}` -> ClientMessage[] for the thread
  "artifacts", // keyed conversationId -> ClientArtifact[]
  "folders",
  "projects",
  "memories",
  "prompts",
  "meta", // cursor, bootstrap snapshot, model manifest
  "pendingMutations",
  "codeSessions", // keyed sessionId -> persisted code-session transcript/meta
] as const;

export type StoreName = (typeof STORES)[number];

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const name of STORES) {
        if (!db.objectStoreNames.contains(name)) db.createObjectStore(name);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("IndexedDB open failed"));
  });
  return dbPromise;
}

function requestToPromise<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("IndexedDB request failed"));
  });
}

export async function dbGet<T>(store: StoreName, key: string): Promise<T | undefined> {
  const db = await openDb();
  return requestToPromise(db.transaction(store).objectStore(store).get(key) as IDBRequest<T>);
}

export async function dbGetAll<T>(store: StoreName): Promise<T[]> {
  const db = await openDb();
  return requestToPromise(db.transaction(store).objectStore(store).getAll() as IDBRequest<T[]>);
}

export async function dbGetAllEntries<T>(store: StoreName): Promise<Array<[string, T]>> {
  const db = await openDb();
  const tx = db.transaction(store).objectStore(store);
  const [keys, values] = await Promise.all([
    requestToPromise(tx.getAllKeys() as IDBRequest<IDBValidKey[]>),
    requestToPromise(tx.getAll() as IDBRequest<T[]>),
  ]);
  return keys.map((k, i) => [String(k), values[i] as T]);
}

export async function dbPut(store: StoreName, key: string, value: unknown): Promise<void> {
  const db = await openDb();
  await requestToPromise(db.transaction(store, "readwrite").objectStore(store).put(value, key));
}

export async function dbDelete(store: StoreName, key: string): Promise<void> {
  const db = await openDb();
  await requestToPromise(db.transaction(store, "readwrite").objectStore(store).delete(key));
}

export async function dbClear(store: StoreName): Promise<void> {
  const db = await openDb();
  await requestToPromise(db.transaction(store, "readwrite").objectStore(store).clear());
}

/** Bulk replace a store's contents in one transaction (used by full resync). */
export async function dbReplaceAll(
  store: StoreName,
  entries: Array<[string, unknown]>,
): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(store, "readwrite");
  const os = tx.objectStore(store);
  os.clear();
  for (const [key, value] of entries) os.put(value, key);
  await new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("IndexedDB transaction failed"));
    tx.onabort = () => reject(tx.error ?? new Error("IndexedDB transaction aborted"));
  });
}

/** Wipes every store — used on sign-out so no account data survives locally. */
export async function dbWipe(): Promise<void> {
  await Promise.all(STORES.map((s) => dbClear(s)));
}
