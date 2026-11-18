import type { User } from 'firebase/auth';
import { useEffect, useState } from 'react';
import { create } from 'zustand';
import { isUntouched } from '../model/examples';
import { useStore } from '../state/store';
import { parseProject } from '../model/validate';
import { toast } from '../ui/toastStore';
import { askConfirm, showMessage } from '../ui/dialogs';
import { Modal } from '../ui/Modal';
import { useMenu } from '../ui/useMenu';
import { applyOutsideChange } from '../state/history';
import { CloudConflict, explainSaveError, isDirty, onRemote, signature, sizeProblem, type RemoteCopy } from './sync';
import { cloudEnabled, fakeCloud } from './config';
import type { BoatSummary } from './firebase';

/** The Firebase SDK is large: load it after first paint, only when cloud storage is configured. */
const fb = () => (fakeCloud ? import('./fakeCloud') : import('./firebase'));

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

type Status =
  | 'idle'
  /** Changes here are waiting to be sent. */
  | 'unsaved'
  | 'saving'
  | 'saved'
  /** No connection; will retry. */
  | 'offline'
  /** The cloud refused the save; see `error`. */
  | 'error'
  /** Another device changed the boat while there were unsaved changes here; see `conflict`. */
  | 'conflict';

interface CloudState {
  user: User | null;
  ready: boolean;
  boats: BoatSummary[];
  status: Status;
  /** Plain-English reason for 'error' or 'offline'. */
  error?: string;
  /** The other device's copy, while the user decides what to do about it. */
  conflict?: RemoteCopy;
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
const RETRY_MS = 20000;

const cloud = () => useCloud.getState();
const text = (p: unknown) => JSON.stringify(p);

/** Text of our most recent save, so its confirmation is recognised even if the user has typed since. */
let lastSent: string | undefined;

/** Parse a cloud copy into a project, or explain why it cannot be used. */
function readCopy(data: string | undefined) {
  let raw: unknown;
  try {
    raw = JSON.parse(data ?? '');
  } catch {
    throw new Error('The saved copy is damaged and cannot be read.');
  }
  return parseProject(raw);
}

/**
 * Send the open boat to the cloud now. With `force`, overwrite whatever is there; otherwise the
 * save only goes through if no other device has saved since this browser last looked.
 * Returns true when the cloud has this version.
 */
async function saveNow(force = false): Promise<boolean> {
  const st = useStore.getState();
  const { user } = cloud();
  const id = st.cloudId;
  if (!user || !id) return false;
  const project = st.project;
  const data = text(project);
  if (!force && !isDirty(data, st.cloudBase)) {
    cloud().set({ status: 'saved', error: undefined });
    return true;
  }
  const tooBig = sizeProblem(data, project.existing?.underlay?.src.length ?? 0);
  if (tooBig) {
    cloud().set({ status: 'error', error: tooBig });
    return false;
  }
  cloud().set({ status: 'saving' });
  lastSent = data;
  try {
    const rev = await (await fb()).saveBoat(user.uid, id, project, data, force || !st.cloudBase ? 'any' : st.cloudBase.rev);
    const now = useStore.getState();
    if (now.cloudId !== id) return true; // switched boats while saving
    const base = { rev, sig: signature(data) };
    now.setCloudBase(base);
    // More typing may have happened while the save was in flight; the autosave effect will send it.
    cloud().set({ status: isDirty(text(now.project), base) ? 'unsaved' : 'saved', error: undefined, conflict: undefined });
    return true;
  } catch (e) {
    if (e instanceof CloudConflict) {
      if (e.remote.exists) cloud().set({ status: 'conflict', conflict: e.remote, error: undefined });
      else boatWasDeleted(id);
      return false;
    }
    const why = explainSaveError(e);
    cloud().set({ status: why.offline ? 'offline' : 'error', error: why.message });
    return false;
  }
}

function boatWasDeleted(id: string) {
  if (useStore.getState().cloudId !== id) return;
  useStore.getState().setCloudId(undefined);
  cloud().set({ status: 'idle', conflict: undefined, error: undefined });
  toast('This boat was deleted from your account on another device. It is still open here: use “Save to cloud” to keep it.', { ms: 20000 });
}

/** The cloud copy of the open boat changed, or was looked at for the first time. */
function onCloudCopy(id: string, remote: RemoteCopy) {
  const st = useStore.getState();
  if (st.cloudId !== id) return;
  const decision = onRemote(text(st.project), st.cloudBase, lastSent, remote);
  if (decision === 'in-sync') return;
  if (decision === 'deleted') return boatWasDeleted(id);
  const base = { rev: remote.rev ?? 0, sig: signature(remote.data ?? '') };
  if (decision === 'adopt') {
    st.setCloudBase(base);
    if (cloud().status === 'conflict') cloud().set({ status: 'saved', conflict: undefined });
    return;
  }
  if (decision === 'take-remote') {
    try {
      const { project } = readCopy(remote.data);
      // The saved base describes the text as it is in the cloud, so re-reading it here stays "in sync".
      applyOutsideChange(() => st.loadProject(project, id, base));
      cloud().set({ status: 'saved', conflict: undefined, error: undefined });
      toast('Updated with changes made on another device.');
    } catch (e) {
      cloud().set({ status: 'error', error: `A newer version of this boat is in your account, but it could not be opened. ${(e as Error).message}` });
    }
    return;
  }
  cloud().set({ status: 'conflict', conflict: remote, error: undefined });
}

// ---- what the user can do about a conflict

function useTheirs() {
  const { conflict } = cloud();
  const id = useStore.getState().cloudId;
  if (!conflict || !id) return;
  try {
    const { project } = readCopy(conflict.data);
    // Recorded as an ordinary change, so Undo brings this device's version back.
    useStore.getState().loadProject(project, id, { rev: conflict.rev ?? 0, sig: signature(conflict.data ?? '') });
    cloud().set({ status: 'saved', conflict: undefined });
  } catch (e) {
    void showMessage('The other version could not be opened', (e as Error).message);
  }
}

async function keepMine() {
  cloud().set({ conflict: undefined });
  await saveNow(true);
}

async function saveMineAsCopy() {
  const { user } = cloud();
  if (!user) return;
  const st = useStore.getState();
  const name = `${st.project.profile.name} (copy)`;
  st.updateProfile((p) => void (p.name = name));
  const project = useStore.getState().project;
  const data = text(project);
  try {
    const made = await (await fb()).createBoat(user.uid, project, data);
    useStore.getState().setCloudId(made.id, { rev: made.rev, sig: signature(data) });
    cloud().set({ status: 'saved', conflict: undefined, error: undefined });
    toast(`Saved here as “${name}”. The other device's version is still in My boats.`, { ms: 12000 });
  } catch (e) {
    void showMessage('Could not save a copy', sizeProblem(data) ?? explainSaveError(e).message);
  }
}

/** Mount once: tracks the signed-in user, their boat list, and keeps the open boat in step with the cloud. */
export function CloudSync() {
  const user = useCloud((s) => s.user);
  const status = useCloud((s) => s.status);
  const conflict = useCloud((s) => s.conflict);
  const setCloud = useCloud((s) => s.set);
  const project = useStore((s) => s.project);
  const cloudId = useStore((s) => s.cloudId);
  const setCloudId = useStore((s) => s.setCloudId);

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
    const onError = (e: Error) => console.warn('Could not list cloud boats:', e.message);
    return subscribeLater((m) => m.watchBoats(user.uid, (boats) => setCloud({ boats }), onError), onError);
  }, [user, setCloud]);

  // Watch the open boat's cloud copy, to notice saves from other devices.
  useEffect(() => {
    if (!user || !cloudId) {
      setCloud({ status: 'idle', conflict: undefined, error: undefined });
      return;
    }
    lastSent = undefined;
    const onError = (e: Error) => console.warn('Could not watch the cloud copy:', e.message);
    return subscribeLater((m) => m.watchBoat(user.uid, cloudId, (remote) => onCloudCopy(cloudId, remote), onError), onError);
  }, [user, cloudId, setCloud]);

  // Autosave the open boat a moment after the last change. Paused while the user resolves a conflict.
  useEffect(() => {
    if (!user || !cloudId || conflict) return;
    if (!isDirty(text(project), useStore.getState().cloudBase)) return;
    if (cloud().status !== 'saving') setCloud({ status: 'unsaved' });
    const t = setTimeout(() => void saveNow(), AUTOSAVE_MS);
    return () => clearTimeout(t);
  }, [user, cloudId, project, conflict, setCloud]);

  // After a failed save, keep trying: on a timer, and as soon as the connection returns.
  useEffect(() => {
    if (status !== 'offline' && status !== 'error') return;
    const retry = () => void saveNow();
    const t = setTimeout(retry, RETRY_MS);
    window.addEventListener('online', retry);
    return () => {
      clearTimeout(t);
      window.removeEventListener('online', retry);
    };
  }, [status, project]);

  // Closing the tab with changes still on their way to the cloud: let the browser warn.
  useEffect(() => {
    if (status !== 'unsaved' && status !== 'saving') return;
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [status]);

  return null;
}

/** Bar under the header for anything about the cloud copy that needs the user: a conflict, or a save that failed. */
export function CloudNotice() {
  const { status, error, conflict } = useCloud();
  const cloudId = useStore((s) => s.cloudId);
  const [busy, setBusy] = useState(false);
  if (!cloudId) return null;
  const run = (fn: () => void | Promise<void>) => async () => {
    setBusy(true);
    try {
      await fn();
    } finally {
      setBusy(false);
    }
  };
  if (status === 'conflict' && conflict) {
    const when = conflict.rev ? new Date(conflict.rev).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : 'recently';
    return (
      <div className="cloud-notice conflict" role="alert">
        <p>
          <b>This boat was changed on another device</b> ({when}), and you have changes here that are not in your account yet. Saving is paused until you choose which to keep.
        </p>
        <div className="crash-actions">
          <button disabled={busy} onClick={run(useTheirs)} data-tip="Replace what is on this screen with the version saved from the other device. You can undo this.">
            Use the other version
          </button>
          <button disabled={busy} onClick={run(keepMine)} data-tip="Save what is on this screen over the other device's version.">
            Keep mine
          </button>
          <button disabled={busy} onClick={run(saveMineAsCopy)} data-tip="Keep both: save what is on this screen as a separate boat, and leave the other version as it is.">
            Save mine as a copy
          </button>
        </div>
      </div>
    );
  }
  if (status === 'error' && error) {
    return (
      <div className="cloud-notice" role="alert">
        <p>
          <b>Not saved to your account.</b> {error}
        </p>
        <div className="crash-actions">
          <button disabled={busy} onClick={run(async () => void (await saveNow()))}>
            Retry now
          </button>
        </div>
      </div>
    );
  }
  return null;
}

const STATUS_TEXT: Record<Status, string> = { idle: 'Saved', saved: 'Saved', unsaved: 'Saving…', saving: 'Saving…', offline: 'Offline', error: 'Not saved', conflict: 'Changed elsewhere' };
const STATUS_TIP: Record<Status, string> = {
  idle: 'Changes to this boat save to your account automatically.',
  saved: 'Changes to this boat save to your account automatically.',
  unsaved: 'Sending your latest changes to your account.',
  saving: 'Sending your latest changes to your account.',
  offline: 'No connection. Your changes are safe in this browser and will be saved when the connection returns.',
  error: 'The last save did not go through. See the message below the header.',
  conflict: 'Another device changed this boat. Choose which version to keep in the message below the header.',
};

/** Header control: sign-in button or account menu + save status. */
export function CloudControls() {
  const { user, ready, status, set } = useCloud();
  const cloudId = useStore((s) => s.cloudId);
  const account = useMenu();
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
            if (!msg.includes('popup-closed')) void showMessage('Sign-in failed', msg);
          } finally {
            setBusy(false);
          }
        }}
      >
        <GoogleG /> Sign in
      </button>
    );
  }

  return (
    <div className="cloud">
      {cloudId ? (
        <span className={`cloud-status st-${status}`} data-tip={STATUS_TIP[status]}>
          {STATUS_TEXT[status]}
        </span>
      ) : (
        <button
          className="save-cloud"
          disabled={busy}
          data-tip="Store this boat in your account. After this, changes save automatically."
          onClick={async () => {
            setBusy(true);
            await saveAsNewBoat(user);
            setBusy(false);
          }}
        >
          Save to cloud
        </button>
      )}
      <button onClick={() => set({ dialog: true })} data-tip="Open, switch between, or delete the boats saved in your account.">My boats</button>
      <button className="avatar" {...account.trigger} aria-label={`Account: ${user.displayName ?? user.email ?? 'signed in'}`} title={user.email ?? ''}>
        {user.photoURL ? <img src={user.photoURL} alt="" referrerPolicy="no-referrer" /> : (user.displayName ?? user.email ?? '?').slice(0, 1)}
      </button>
      {account.open && (
        <div className="menu" aria-label="Account" {...account.panel}>
          <div className="menu-who">
            <b>{user.displayName}</b>
            <span>{user.email}</span>
          </div>
          <hr />
          <button
            onClick={async () => {
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

/** Put the open boat into the account as a new boat and link to it. Returns false, after telling the user, if it could not. */
async function saveAsNewBoat(user: User): Promise<boolean> {
  const project = useStore.getState().project;
  const data = text(project);
  const tooBig = sizeProblem(data, project.existing?.underlay?.src.length ?? 0);
  if (tooBig) {
    void showMessage('This boat is too large for your account', tooBig);
    return false;
  }
  try {
    const made = await (await fb()).createBoat(user.uid, project, data);
    useStore.getState().setCloudId(made.id, { rev: made.rev, sig: signature(data) });
    cloud().set({ status: 'saved', error: undefined, conflict: undefined });
    return true;
  } catch (e) {
    void showMessage(`Could not save “${project.profile.name}” to your account`, explainSaveError(e).message);
    return false;
  }
}

/** What the user asked for in My boats while the open boat still needs dealing with. */
type Pending = { kind: 'new' } | { kind: 'open'; boat: BoatSummary };

function BoatsDialog() {
  const { user, boats, dialog, set } = useCloud();
  const cloudId = useStore((s) => s.cloudId);
  const openName = useStore((s) => s.project.profile.name);
  const [busy, setBusy] = useState<string | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  if (!dialog || !user) return null;
  const close = () => {
    setPending(null);
    set({ dialog: false });
  };

  /** Replace the open boat with another one. Call only once the open boat is safe. */
  const go = async (what: Pending) => {
    setPending(null);
    setBusy(what.kind === 'open' ? what.boat.id : 'new');
    try {
      if (what.kind === 'new') {
        useStore.getState().newProject();
        await saveAsNewBoat(user);
      } else {
        const remote = await (await fb()).readBoat(user.uid, what.boat.id);
        if (!remote.exists) throw new Error('It is no longer in your account.');
        const { project, notes } = readCopy(remote.data);
        // The base is the text as stored, so a boat that was repaired on the way in counts as changed and is saved back.
        useStore.getState().loadProject(project, what.boat.id, { rev: remote.rev ?? 0, sig: signature(remote.data ?? '') });
        if (notes.length) toast(`Opened with repairs: ${notes.join(' ')}`, { ms: 15000 });
      }
      close();
    } catch (e) {
      void showMessage(`Could not open ${what.kind === 'open' ? `“${what.boat.name}”` : 'a new boat'}`, (e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  /** New boat / Open were clicked: first make sure the boat that is open now will not be lost. */
  const leave = async (what: Pending) => {
    const st = useStore.getState();
    if (st.cloudId) {
      // In the account already: get the latest changes there before switching.
      setBusy(what.kind === 'open' ? what.boat.id : 'new');
      const ok = cloud().status === 'conflict' ? false : await saveNow();
      setBusy(null);
      if (!ok) {
        void showMessage(
          `“${st.project.profile.name}” is not fully saved yet`,
          cloud().status === 'conflict'
            ? 'Another device changed this boat too. Choose which version to keep first (see the message under the header). Nothing was opened.'
            : `Your latest changes are not in your account yet: ${cloud().error ?? 'the save did not go through'} Nothing was opened.`,
        );
        return;
      }
      return go(what);
    }
    // Only in this browser. An untouched new or example boat loses nothing; anything else, ask.
    if (isUntouched(st.project)) return go(what);
    setPending(what);
  };

  return (
    <Modal label="My boats" onClose={close}>
        <div className="modal-head">
          <h3>My boats</h3>
          <button className="icon" onClick={close} aria-label="Close">
            ×
          </button>
        </div>
        {pending ? (
          <div className="leave" role="alert">
            <p>
              <b>“{openName}” is only saved in this browser.</b> {pending.kind === 'new' ? 'Starting a new boat' : `Opening “${pending.boat.name}”`} will replace it on screen.
            </p>
            <div className="crash-actions">
              <button
                className="primary"
                disabled={!!busy}
                onClick={async () => {
                  setBusy('save');
                  const ok = await saveAsNewBoat(user);
                  setBusy(null);
                  if (ok) await go(pending);
                }}
              >
                {busy === 'save' ? 'Saving…' : 'Save it to my boats first'}
              </button>
              <button disabled={!!busy} onClick={() => go(pending)} data-tip="Replace it without saving it to your account. You can still undo straight afterwards.">
                Replace without saving
              </button>
              <button disabled={!!busy} onClick={() => setPending(null)}>
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <>
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
                    <button disabled={!!busy} onClick={() => leave({ kind: 'open', boat: b })}>
                      {busy === b.id ? 'Opening…' : 'Open'}
                    </button>
                  )}
                  <button
                    className="link danger"
                    disabled={!!busy}
                    onClick={async () => {
                      if (!(await askConfirm(`Delete “${b.name}”?`, 'It will be removed from your account on every device. This cannot be undone.', { label: 'Delete it', danger: true }))) return;
                      setBusy(b.id);
                      try {
                        await (await fb()).deleteBoat(user.uid, b.id);
                        if (b.id === useStore.getState().cloudId) {
                          useStore.getState().setCloudId(undefined);
                          toast(`“${b.name}” was deleted from your account. It is still open here: use “Save to cloud” to keep it.`, { ms: 15000 });
                        }
                      } catch (e) {
                        void showMessage(`Could not delete “${b.name}”`, explainSaveError(e).message);
                      } finally {
                        setBusy(null);
                      }
                    }}
                  >
                    Delete
                  </button>
                </div>
              ))}
            </div>
            <div className="modal-foot">
              <button className="primary" disabled={!!busy} onClick={() => leave({ kind: 'new' })}>
                {busy === 'new' ? 'Starting…' : '+ New boat'}
              </button>
            </div>
          </>
        )}
    </Modal>
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
