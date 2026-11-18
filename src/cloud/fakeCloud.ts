// In-memory stand-in for firebase.ts, for development and automated tests (VITE_CLOUD_FAKE=1).
//
// It behaves like the real cloud as far as the app can tell: one made-up user, boats with a
// server-set "updated" time, saves that are refused if the copy changed since the caller last
// looked, watchers that are told about every confirmed write, the same size limit as
// firestore.rules, and an "offline" switch. `window.fakeCloud` lets a test (or you, in the
// console) play the part of a second device. It is never part of a production build.

import type { User } from 'firebase/auth';
import type { Project } from '../model/types';
import type * as Real from './firebase';
import { CLOUD_MAX_CHARS, CloudConflict, type RemoteCopy } from './sync';

interface Boat {
  name: string;
  data: string;
  version: number;
  updatedAt: number;
}

const KEY = 'boatwire:fake-cloud';
interface Saved {
  signedIn: boolean;
  boats: Record<string, Boat>;
  seq: number;
}
const load = (): Saved => {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? '') as Saved;
  } catch {
    return { signedIn: false, boats: {}, seq: 0 };
  }
};
const state = load();
const persist = () => localStorage.setItem(KEY, JSON.stringify(state));

const USER = { uid: 'fake-user', email: 'sailor@example.com', displayName: 'Test Sailor', photoURL: null } as unknown as User;
let offline = false;
let lastRev = Math.max(0, ...Object.values(state.boats).map((b) => b.updatedAt));
const now = () => (lastRev = Math.max(Date.now(), lastRev + 1));
const later = (fn: () => void) => setTimeout(fn, 0);
const refuse = (code: string, message: string) => Object.assign(new Error(message), { code });
const needNetwork = () => {
  if (offline) throw refuse('unavailable', 'Failed to get document because the client is offline.');
};

const userWatchers = new Set<(u: User | null) => void>();
const listWatchers = new Set<() => void>();
const boatWatchers = new Map<string, Set<(r: RemoteCopy) => void>>();

const copyOf = (id: string): RemoteCopy => {
  const b = state.boats[id];
  return b ? { exists: true, rev: b.updatedAt, data: b.data } : { exists: false };
};
/** Tell everyone watching about the state of the cloud, as the real thing does after a confirmed write. */
function announce(id?: string) {
  persist();
  if (offline) return;
  later(() => {
    for (const w of listWatchers) w();
    if (id) for (const w of boatWatchers.get(id) ?? []) w(copyOf(id));
  });
}
function write(id: string, name: string, data: string, version: number) {
  // firestore.rules: d.data.size() <= 900000
  if (data.length > CLOUD_MAX_CHARS) throw refuse('permission-denied', 'Missing or insufficient permissions.');
  state.boats[id] = { name: name || 'Untitled', data, version, updatedAt: now() };
}

export function watchUser(cb: (u: User | null) => void): () => void {
  userWatchers.add(cb);
  later(() => cb(state.signedIn ? USER : null));
  return () => void userWatchers.delete(cb);
}
export async function signInWithGoogle() {
  state.signedIn = true;
  persist();
  for (const w of userWatchers) w(USER);
}
export async function signOutUser() {
  state.signedIn = false;
  persist();
  for (const w of userWatchers) w(null);
}

export function watchBoats(_uid: string, cb: (boats: Real.BoatSummary[]) => void): () => void {
  const tell = () =>
    cb(
      Object.entries(state.boats)
        .map(([id, b]) => ({ id, name: b.name, updatedAt: new Date(b.updatedAt) }))
        .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime()),
    );
  listWatchers.add(tell);
  later(tell);
  return () => void listWatchers.delete(tell);
}

export async function readBoat(_uid: string, id: string): Promise<RemoteCopy> {
  needNetwork();
  return copyOf(id);
}

export async function createBoat(_uid: string, project: Project, data: string): Promise<{ id: string; rev: number }> {
  needNetwork();
  const id = `boat${++state.seq}`;
  write(id, project.profile.name, data, project.version);
  announce(id);
  return { id, rev: state.boats[id].updatedAt };
}

export async function saveBoat(_uid: string, id: string, project: Project, data: string, baseRev: number | 'any'): Promise<number> {
  needNetwork();
  if (baseRev !== 'any') {
    const remote = copyOf(id);
    if (!remote.exists || (remote.rev !== baseRev && remote.data !== data)) throw new CloudConflict(remote);
  }
  write(id, project.profile.name, data, project.version);
  announce(id);
  return state.boats[id].updatedAt;
}

export function watchBoat(_uid: string, id: string, cb: (remote: RemoteCopy) => void): () => void {
  if (!boatWatchers.has(id)) boatWatchers.set(id, new Set());
  boatWatchers.get(id)!.add(cb);
  later(() => !offline && cb(copyOf(id)));
  return () => void boatWatchers.get(id)?.delete(cb);
}

export async function deleteBoat(_uid: string, id: string) {
  needNetwork();
  delete state.boats[id];
  announce(id);
}

// The fake must offer exactly what the app uses from the real module.
const sameShape: Pick<typeof Real, 'watchUser' | 'signInWithGoogle' | 'signOutUser' | 'watchBoats' | 'readBoat' | 'createBoat' | 'saveBoat' | 'watchBoat' | 'deleteBoat'> = {
  watchUser,
  signInWithGoogle,
  signOutUser,
  watchBoats,
  readBoat,
  createBoat,
  saveBoat,
  watchBoat,
  deleteBoat,
};
void sameShape;

/** Play the part of another device, from a test or the browser console. */
const controls = {
  /** Another device saves `data` over a boat. With `quiet`, this browser is not told (as if its connection was slow). */
  remoteSave(id: string, data: string, opts: { quiet?: boolean } = {}) {
    const b = state.boats[id];
    if (!b) throw new Error(`no boat ${id}`);
    let name = b.name;
    try {
      name = (JSON.parse(data) as Project).profile.name;
    } catch {
      // keep the old name for unreadable data
    }
    state.boats[id] = { ...b, name, data, updatedAt: now() };
    if (opts.quiet) persist();
    else announce(id);
  },
  remoteDelete(id: string) {
    delete state.boats[id];
    announce(id);
  },
  /** Cut or restore the connection. Restoring it delivers the current state to watchers, as reconnecting does. */
  offline(on: boolean) {
    offline = on;
    if (!on) {
      window.dispatchEvent(new Event('online'));
      later(() => {
        for (const w of listWatchers) w();
        for (const [id, ws] of boatWatchers) for (const w of ws) w(copyOf(id));
      });
    }
  },
  boats: () => structuredClone(state.boats),
  reset() {
    state.boats = {};
    state.signedIn = false;
    state.seq = 0;
    persist();
  },
};
(window as unknown as { fakeCloud: typeof controls }).fakeCloud = controls;
