// Firebase: Google sign-in + per-user boat storage in Firestore.
//
// Configuration comes from VITE_FIREBASE_* environment variables (see
// .env.example). Without them the app runs local-only (browser storage).
// This module pulls in the Firebase SDK, so the UI imports it lazily (see
// CloudControls.tsx) to keep it out of the initial download.
// The Firebase web config is not a secret; access is enforced by
// firestore.rules (each user can only read/write their own boats).

import { initializeApp, type FirebaseApp } from 'firebase/app';
import { getAuth, GoogleAuthProvider, onAuthStateChanged, signInWithPopup, signOut, type Auth, type User } from 'firebase/auth';
import {
  collection,
  deleteDoc,
  doc,
  getDocFromServer,
  getFirestore,
  onSnapshot,
  orderBy,
  query,
  runTransaction,
  serverTimestamp,
  setDoc,
  addDoc,
  type DocumentSnapshot,
  type Firestore,
  type Timestamp,
} from 'firebase/firestore';
import type { Project } from '../model/types';
import { cloudEnabled, config } from './config';
import { CloudConflict, type RemoteCopy } from './sync';

let app: FirebaseApp | undefined;
let auth: Auth | undefined;
let db: Firestore | undefined;

function init() {
  if (!cloudEnabled) throw new Error('Cloud storage is not configured');
  if (!app) {
    app = initializeApp(config);
    auth = getAuth(app);
    db = getFirestore(app);
  }
  return { auth: auth!, db: db! };
}

export function watchUser(cb: (u: User | null) => void): () => void {
  if (!cloudEnabled) return () => {};
  return onAuthStateChanged(init().auth, cb);
}

export async function signInWithGoogle() {
  const provider = new GoogleAuthProvider();
  provider.setCustomParameters({ prompt: 'select_account' });
  await signInWithPopup(init().auth, provider);
}

export async function signOutUser() {
  await signOut(init().auth);
}

export interface BoatSummary {
  id: string;
  name: string;
  updatedAt?: Date;
}

const boatsCol = (uid: string) => collection(init().db, 'users', uid, 'boats');

export function watchBoats(uid: string, cb: (boats: BoatSummary[]) => void, onError: (e: Error) => void): () => void {
  return onSnapshot(
    query(boatsCol(uid), orderBy('updatedAt', 'desc')),
    (snap) =>
      cb(
        snap.docs.map((d) => ({
          id: d.id,
          name: String(d.get('name') ?? 'Untitled'),
          updatedAt: (d.get('updatedAt') as Timestamp | null)?.toDate(),
        })),
      ),
    onError,
  );
}

/** Projects are stored as a JSON string to sidestep Firestore's nested-array and undefined-value limits. */
const payload = (name: string, data: string, version: number) => ({ name: name || 'Untitled', data, version, updatedAt: serverTimestamp() });

const remoteOf = (snap: DocumentSnapshot): RemoteCopy =>
  snap.exists() ? { exists: true, rev: (snap.get('updatedAt') as Timestamp | null)?.toMillis(), data: String(snap.get('data') ?? '') } : { exists: false };

/** The cloud copy as the server has it right now (never from a local cache). */
export async function readBoat(uid: string, id: string): Promise<RemoteCopy> {
  return remoteOf(await getDocFromServer(doc(boatsCol(uid), id)));
}

/** Store a boat as a new entry in the account. Returns its id and the time the server recorded. */
export async function createBoat(uid: string, project: Project, data: string): Promise<{ id: string; rev: number }> {
  const ref = await addDoc(boatsCol(uid), { ...payload(project.profile.name, data, project.version), createdAt: serverTimestamp() });
  const saved = await readBoat(uid, ref.id);
  return { id: ref.id, rev: saved.rev ?? Date.now() };
}

/**
 * Save over an existing boat, but only if the cloud copy is still the one this browser last saw
 * (`baseRev`). If another device has saved since, or deleted the boat, nothing is written and a
 * CloudConflict carrying their copy is thrown. Pass `baseRev: 'any'` to overwrite regardless.
 * Returns the time the server recorded for this save.
 */
export async function saveBoat(uid: string, id: string, project: Project, data: string, baseRev: number | 'any'): Promise<number> {
  const ref = doc(boatsCol(uid), id);
  const body = payload(project.profile.name, data, project.version);
  if (baseRev === 'any') {
    await setDoc(ref, body, { merge: true });
  } else {
    await runTransaction(init().db, async (tx) => {
      const remote = remoteOf(await tx.get(ref));
      // Identical text is not a conflict, whoever wrote it.
      if (!remote.exists || (remote.rev !== baseRev && remote.data !== data)) throw new CloudConflict(remote);
      tx.set(ref, body, { merge: true });
    });
  }
  return (await readBoat(uid, id)).rev ?? Date.now();
}

/**
 * Watch one boat. `cb` is called with the copy the server has confirmed: local, not-yet-saved
 * writes and cached data are skipped, so a call always means "this is what is in the cloud".
 */
export function watchBoat(uid: string, id: string, cb: (remote: RemoteCopy) => void, onError: (e: Error) => void): () => void {
  return onSnapshot(
    doc(boatsCol(uid), id),
    { includeMetadataChanges: true },
    (snap) => {
      if (snap.metadata.hasPendingWrites || snap.metadata.fromCache) return;
      cb(remoteOf(snap));
    },
    onError,
  );
}

export async function deleteBoat(uid: string, id: string) {
  await deleteDoc(doc(boatsCol(uid), id));
}
