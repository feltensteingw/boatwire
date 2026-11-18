import type { User } from 'firebase/auth';
import { useEffect, useRef, useState } from 'react';
import { create } from 'zustand';
import type { Project } from '../model/types';
import { useStore } from '../state/store';
import { parseProject } from '../model/validate';
import { toast } from '../ui/toastStore';
import { cloudEnabled } from './config';
import type { BoatSummary } from './firebase';

/** The Firebase SDK is large: load it after first paint, only when cloud storage is configured. */
const fb = () => import('./firebase');

/** Start a Firebase subscription once the SDK has loaded; returns a cleanup usable from useEffect. */
function subscribeLater(start: (m: Awaited<ReturnType<typeof fb>>) => () => void, onError: (e: Error) => void): () => void {
  let stop: (() => void) | undefined;
  let cancelled = false;
  fb()
    .then((m) => {
      if (!cancelled) stop = start(m);
    })
    .catch(onError);
  return () => {
    cancelled = true;
    stop?.();
  };
}

type Status = 'idle' | 'saving' | 'saved' | 'error';

interface CloudState {
  user: User | null;
  ready: boolean;
  boats: BoatSummary[];
  status: Status;
  error?: string;
  dialog: boolean;
  set(p: Partial<CloudState>): void;
}

const useCloud = create<CloudState>((set) => ({
  user: null,
  ready: false,
  boats: [],
  status: 'idle',
  dialog: false,
  set: (p) => set(p),
}));

const AUTOSAVE_MS = 1500;

/** Mount once: tracks the signed-in user, their boat list, and autosaves the open boat. */
export function CloudSync() {
  const user = useCloud((s) => s.user);
  const setCloud = useCloud((s) => s.set);
  const project = useStore((s) => s.project);
  const cloudId = useStore((s) => s.cloudId);
  const setCloudId = useStore((s) => s.setCloudId);
  const lastSaved = useRef<Project | null>(null);

  useEffect(() => {
    if (!cloudEnabled) return;
    return subscribeLater(
      (m) =>
        m.watchUser((u) => {
          setCloud({ user: u, ready: true, boats: u ? useCloud.getState().boats : [] });
          if (!u) setCloudId(undefined);
        }),
      (e) => console.warn('Cloud storage unavailable:', e.message),
    );
  }, [setCloud, setCloudId]);

  useEffect(() => {
    if (!user) return;
    const onError = (e: Error) => setCloud({ status: 'error', error: e.message });
    return subscribeLater((m) => m.watchBoats(user.uid, (boats) => setCloud({ boats }), onError), onError);
  }, [user, setCloud]);

  // Autosave the open boat (debounced). New boats are only uploaded on request.
  useEffect(() => {
    if (!user || !cloudId || project === lastSaved.current) return;
    setCloud({ status: 'saving' });
    const t = setTimeout(async () => {
      try {
        await (await fb()).saveBoat(user.uid, project, cloudId);
        lastSaved.current = project;
        setCloud({ status: 'saved', error: undefined });
      } catch (e) {
        setCloud({ status: 'error', error: (e as Error).message });
      }
    }, AUTOSAVE_MS);
    return () => clearTimeout(t);
  }, [user, cloudId, project, setCloud]);

  return null;
}

/** Header control: sign-in button or account menu + save status. */
export function CloudControls() {
  const { user, ready, status, error, set } = useCloud();
  const cloudId = useStore((s) => s.cloudId);
  const project = useStore((s) => s.project);
  const setCloudId = useStore((s) => s.setCloudId);
  const [menu, setMenu] = useState(false);
  const [busy, setBusy] = useState(false);
  if (!cloudEnabled || !ready) return null;

  if (!user) {
    return (
      <button
        className="signin"
        disabled={busy}
        data-tip="Sign in with Google to save boats to your account and open them on any computer. Without signing in, work is still saved in this browser."
        onClick={async () => {
          setBusy(true);
          try {
            await (await fb()).signInWithGoogle();
          } catch (e) {
            const msg = (e as Error).message;
            if (!msg.includes('popup-closed')) alert(`Sign-in failed: ${msg}`);
          } finally {
            setBusy(false);
          }
        }}
      >
        <GoogleG /> Sign in
      </button>
    );
  }

  const statusText = !cloudId
    ? 'Not saved to cloud'
    : status === 'saving'
      ? 'Saving…'
      : status === 'error'
        ? 'Save failed'
        : 'Saved';

  return (
    <div className="cloud">
      {cloudId ? (
        <span className={`cloud-status st-${cloudId ? status : 'local'}`} data-tip={error ?? 'Changes to this boat save to your account automatically.'}>
          {statusText}
        </span>
      ) : (
        <button
          className="save-cloud"
          disabled={busy}
          data-tip="Store this boat in your account. After this, changes save automatically."
          onClick={async () => {
            setBusy(true);
            try {
              const id = await (await fb()).saveBoat(user.uid, project);
              setCloudId(id);
              set({ status: 'saved' });
            } catch (e) {
              alert(`Could not save: ${(e as Error).message}`);
            } finally {
              setBusy(false);
            }
          }}
        >
          Save to cloud
        </button>
      )}
      <button onClick={() => set({ dialog: true })} data-tip="Open, switch between, or delete the boats saved in your account.">My boats</button>
      <button className="avatar" onClick={() => setMenu(!menu)} title={user.email ?? ''}>
        {user.photoURL ? <img src={user.photoURL} alt="" referrerPolicy="no-referrer" /> : (user.displayName ?? user.email ?? '?').slice(0, 1)}
      </button>
      {menu && (
        <div className="menu" onMouseLeave={() => setMenu(false)}>
          <div className="menu-who">
            <b>{user.displayName}</b>
            <span>{user.email}</span>
          </div>
          <hr />
          <button
            onClick={async () => {
              setMenu(false);
              await (await fb()).signOutUser();
            }}
          >
            Sign out
          </button>
        </div>
      )}
      <BoatsDialog />
    </div>
  );
}

function BoatsDialog() {
  const { user, boats, dialog, set } = useCloud();
  const cloudId = useStore((s) => s.cloudId);
  const loadProject = useStore((s) => s.loadProject);
  const newProject = useStore((s) => s.newProject);
  const [busy, setBusy] = useState<string | null>(null);
  if (!dialog || !user) return null;
  const close = () => set({ dialog: false });
  return (
    <div className="modal-back" onClick={close}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h3>My boats</h3>
          <button className="icon" onClick={close} aria-label="Close">
            ×
          </button>
        </div>
        {boats.length === 0 && <p className="hint">No boats saved yet. Use “Save to cloud” to store the boat you're working on.</p>}
        <div className="boat-list">
          {boats.map((b) => (
            <div key={b.id} className={`boat-row ${b.id === cloudId ? 'current' : ''}`}>
              <div>
                <div className="boat-name">{b.name}</div>
                <div className="hint">{b.updatedAt ? `Updated ${b.updatedAt.toLocaleString()}` : 'Saving…'}</div>
              </div>
              {b.id === cloudId ? (
                <span className="pill-soft">Open</span>
              ) : (
                <button
                  disabled={!!busy}
                  onClick={async () => {
                    setBusy(b.id);
                    try {
                      const saved = await (await fb()).loadBoat(user.uid, b.id);
                      if (saved === null) throw new Error('It is no longer in your account.');
                      let raw: unknown;
                      try {
                        raw = JSON.parse(saved);
                      } catch {
                        throw new Error('The saved copy is damaged and cannot be read.');
                      }
                      const { project, notes } = parseProject(raw);
                      loadProject(project, b.id);
                      close();
                      if (notes.length) toast(`Opened with repairs: ${notes.join(' ')}`, { ms: 15000 });
                    } catch (e) {
                      alert(`Could not open “${b.name}”. ${(e as Error).message}`);
                    } finally {
                      setBusy(null);
                    }
                  }}
                >
                  {busy === b.id ? 'Opening…' : 'Open'}
                </button>
              )}
              <button
                className="link danger"
                disabled={!!busy}
                onClick={async () => {
                  if (!window.confirm(`Delete “${b.name}” from your cloud boats? This cannot be undone.`)) return;
                  await (await fb()).deleteBoat(user.uid, b.id);
                  if (b.id === cloudId) useStore.getState().setCloudId(undefined);
                }}
              >
                Delete
              </button>
            </div>
          ))}
        </div>
        <div className="modal-foot">
          <button
            className="primary"
            onClick={async () => {
              newProject();
              const id = await (await fb()).saveBoat(user.uid, useStore.getState().project);
              useStore.getState().setCloudId(id);
              close();
            }}
          >
            + New boat
          </button>
        </div>
      </div>
    </div>
  );
}

function GoogleG() {
  return (
    <svg width="15" height="15" viewBox="0 0 48 48" aria-hidden>
      <path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z" />
      <path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z" />
      <path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-8l-6.5 5C9.5 39.6 16.2 44 24 44z" />
      <path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z" />
    </svg>
  );
}
