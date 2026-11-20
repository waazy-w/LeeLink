/**
 * Local-only IndexedDB storage. ROM bytes never leave the device: they live in the `roms`
 * store keyed by SHA-1. Saves are cached here and (in a run) also synced to the server.
 */
import type { RomInfo } from '@leelink/shared/rom/identify';

const DB_NAME = 'leelink';
const DB_VERSION = 1;

export interface StoredRom {
  sha1: string;
  info: RomInfo;
  fileName: string;
  data: Uint8Array;
  addedAt: number;
  lastPlayedAt?: number;
}

export interface StoredSave {
  /** `${sha1}` for free play, `${runId}:${sha1}` inside a run. */
  key: string;
  data: Uint8Array;
  updatedAt: number;
}

let dbPromise: Promise<IDBDatabase> | undefined;

function open(): Promise<IDBDatabase> {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('roms')) db.createObjectStore('roms', { keyPath: 'sha1' });
      if (!db.objectStoreNames.contains('saves')) db.createObjectStore('saves', { keyPath: 'key' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx<T>(store: string, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return open().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const t = db.transaction(store, mode);
        const req = fn(t.objectStore(store));
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      }),
  );
}

export const romStore = {
  put: (rom: StoredRom) => tx('roms', 'readwrite', (s) => s.put(rom)),
  get: (sha1: string) => tx<StoredRom | undefined>('roms', 'readonly', (s) => s.get(sha1)),
  list: () => tx<StoredRom[]>('roms', 'readonly', (s) => s.getAll()),
  remove: (sha1: string) => tx('roms', 'readwrite', (s) => s.delete(sha1)),
};

export const saveStore = {
  put: (save: StoredSave) => tx('saves', 'readwrite', (s) => s.put(save)),
  get: (key: string) => tx<StoredSave | undefined>('saves', 'readonly', (s) => s.get(key)),
  remove: (key: string) => tx('saves', 'readwrite', (s) => s.delete(key)),
};
