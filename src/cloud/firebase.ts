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
  getDoc,
  getFirestore,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
  setDoc,
  addDoc,
  type Firestore,
  type Timestamp,
} from 'firebase/firestore';
import type { Project } from '../model/types';
import { cloudEnabled, config } from './config';

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
export async function saveBoat(uid: string, project: Project, id?: string): Promise<string> {
  const payload = {
    name: project.profile.name || 'Untitled',
    data: JSON.stringify(project),
    version: project.version,
    updatedAt: serverTimestamp(),
  };
  if (id) {
    await setDoc(doc(boatsCol(uid), id), payload, { merge: true });
    return id;
  }
  const ref = await addDoc(boatsCol(uid), { ...payload, createdAt: serverTimestamp() });
  return ref.id;
}

export async function loadBoat(uid: string, id: string): Promise<Project | null> {
  const d = await getDoc(doc(boatsCol(uid), id));
  return d.exists() ? (JSON.parse(String(d.get('data'))) as Project) : null;
}

export async function deleteBoat(uid: string, id: string) {
  await deleteDoc(doc(boatsCol(uid), id));
}
