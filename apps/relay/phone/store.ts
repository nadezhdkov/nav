import type { Creds, CredStore } from "./core.ts";

/** The phone's credentials for each relay id, in IndexedDB, shared by the loader page and the service worker. */
const DB = "navarch-relay";
const STORE = "creds";

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function run<T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await open();
  try {
    return await new Promise<T>((resolve, reject) => {
      const req = fn(db.transaction(STORE, mode).objectStore(STORE));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  } finally {
    db.close();
  }
}

export const credStore: CredStore = {
  load: async (relayId) => (await run<Creds | undefined>("readonly", (s) => s.get(relayId))) ?? undefined,
  save: async (relayId, creds) => void (await run("readwrite", (s) => s.put(creds, relayId))),
  clear: async (relayId) => void (await run("readwrite", (s) => s.delete(relayId))),
};
