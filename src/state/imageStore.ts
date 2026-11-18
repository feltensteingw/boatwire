// Where the trace-over picture is kept between visits.
//
// The picture is hundreds of KB of text. Kept inside the project in browser storage, all of it
// was rewritten on every edit and counted against a storage limit of a few MB. Instead it goes
// into IndexedDB once, and the stored project holds only a short reference to it
// ("idb:<id>"). In memory, in project files and in the cloud the project still carries the
// picture itself, so nothing else has to know about this.
//
// If IndexedDB is unavailable the picture simply stays inside the stored project, as before.

import { signature } from '../cloud/sync';
import type { Project } from '../model/types';

/** Prefix of a stored-picture reference in `underlay.src`. Only ever appears in browser storage. */
export const IDB_PREFIX = 'idb:';

const DB_NAME = 'boatwire';
const STORE = 'images';

let opening: Promise<IDBDatabase> | undefined;
function db(): Promise<IDBDatabase> {
  return (opening ??= new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') return reject(new Error('IndexedDB is not available'));
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB could not be opened'));
    req.onblocked = () => reject(new Error('IndexedDB is blocked'));
  }));
}
function run<T>(mode: IDBTransactionMode, work: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return db().then(
    (d) =>
      new Promise<T>((resolve, reject) => {
        const tx = d.transaction(STORE, mode);
        const req = work(tx.objectStore(STORE));
        tx.oncomplete = () => resolve(req.result);
        tx.onerror = () => reject(tx.error ?? new Error('IndexedDB write failed'));
        tx.onabort = () => reject(tx.error ?? new Error('IndexedDB write was aborted'));
      }),
  );
}

export const getImage = (id: string) => run<string | undefined>('readonly', (s) => s.get(id));
const putImage = (id: string, data: string) => run('readwrite', (s) => s.put(data, id));
const allKeys = () => run<IDBValidKey[]>('readonly', (s) => s.getAllKeys());
const deleteImage = (id: string) => run('readwrite', (s) => s.delete(id));

/** Ids confirmed to be in IndexedDB. Only these are replaced by a reference in the stored project. */
const stored = new Set<string>();

// Naming a picture means hashing all of its text, so remember the last answer. The same string
// instance is passed again and again while the picture is unchanged.
let lastSrc: string | undefined;
let lastId = '';
export function imageId(src: string): string {
  if (src !== lastSrc) {
    lastSrc = src;
    lastId = `img-${signature(src)}`;
  }
  return lastId;
}

/** The project as it should be written to browser storage: the picture swapped for a reference once it is safely stored. */
export function storable(p: Project): Project {
  const u = p.existing?.underlay;
  if (!u || !u.src.startsWith('data:')) return p;
  const id = imageId(u.src);
  if (!stored.has(id)) return p; // not confirmed in IndexedDB (yet, or ever): keep it in the project
  return { ...p, existing: { ...p.existing!, underlay: { ...u, src: IDB_PREFIX + id } } };
}

/**
 * Make sure the open project's picture is in IndexedDB. Resolves true if it was newly stored,
 * which means the stored project can now shrink to a reference.
 */
export async function keep(p: Project): Promise<boolean> {
  const src = p.existing?.underlay?.src;
  if (!src || !src.startsWith('data:')) return false;
  const id = imageId(src);
  if (stored.has(id)) return false;
  try {
    await putImage(id, src);
    stored.add(id);
    return true;
  } catch {
    return false; // stays inline in browser storage
  }
}

/** The picture behind a stored reference, or undefined if this browser no longer has it. */
export async function fetchStored(src: string): Promise<string | undefined> {
  const id = src.slice(IDB_PREFIX.length);
  try {
    const data = await getImage(id);
    if (typeof data === 'string' && data.startsWith('data:image/')) {
      stored.add(id);
      return data;
    }
  } catch {
    // unavailable: treated as lost
  }
  return undefined;
}

/** Drop pictures no project refers to any more (replaced or removed in an earlier visit). */
export async function forgetAllBut(p: Project): Promise<void> {
  const src = p.existing?.underlay?.src;
  const keepId = src?.startsWith('data:') ? imageId(src) : src?.startsWith(IDB_PREFIX) ? src.slice(IDB_PREFIX.length) : undefined;
  try {
    for (const k of await allKeys()) if (k !== keepId) await deleteImage(String(k));
  } catch {
    // nothing to tidy
  }
}
