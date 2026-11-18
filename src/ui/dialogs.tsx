// In-app replacements for the browser's alert() and confirm() boxes: themed, readable by
// screen readers, and they do not freeze the page.

import { create } from 'zustand';
import { Modal } from './Modal';

interface Ask {
  title: string;
  body: string;
  /** Present for a question; absent for a message that only needs "OK". */
  confirm?: { label: string; danger?: boolean };
  done: (yes: boolean) => void;
}

const useDialogs = create<{ queue: Ask[] }>(() => ({ queue: [] }));
const push = (a: Ask) => useDialogs.setState((s) => ({ queue: [...s.queue, a] }));

/** Tell the user something that went wrong (or that they must know). Resolves when they dismiss it. */
export function showMessage(title: string, body: string): Promise<void> {
  return new Promise((resolve) => push({ title, body, done: () => resolve() }));
}

/** Ask before doing something that cannot be undone. Resolves true only if the user confirms. */
export function askConfirm(title: string, body: string, confirm: { label: string; danger?: boolean }): Promise<boolean> {
  return new Promise((resolve) => push({ title, body, confirm, done: resolve }));
}

/** Mount once. Shows the oldest waiting message or question. */
export function DialogLayer() {
  const ask = useDialogs((s) => s.queue[0]);
  if (!ask) return null;
  const answer = (yes: boolean) => {
    useDialogs.setState((s) => ({ queue: s.queue.slice(1) }));
    ask.done(yes);
  };
  return (
    // `key` gives each message its own dialog, so focus handling runs again for the next one.
    <Modal key={ask.title + ask.body} label={ask.title} alert className="ask" onClose={() => answer(false)}>
      <h3>{ask.title}</h3>
      <p>{ask.body}</p>
      <div className="modal-foot">
        {ask.confirm ? (
          <>
            <button data-autofocus onClick={() => answer(false)}>
              Cancel
            </button>
            <button className={ask.confirm.danger ? 'danger' : 'primary'} onClick={() => answer(true)}>
              {ask.confirm.label}
            </button>
          </>
        ) : (
          <button className="primary" data-autofocus onClick={() => answer(false)}>
            OK
          </button>
        )}
      </div>
    </Modal>
  );
}
