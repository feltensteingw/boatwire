// Brief messages at the bottom of the screen, optionally with one action (e.g. Undo).

import { create } from 'zustand';

export interface Toast {
  id: number;
  message: string;
  action?: { label: string; run: () => void };
}

interface ToastState {
  toasts: Toast[];
  dismiss(id: number): void;
}

export const useToasts = create<ToastState>((set, get) => ({
  toasts: [],
  dismiss: (id) => set({ toasts: get().toasts.filter((t) => t.id !== id) }),
}));

let nextId = 1;
const MAX_SHOWN = 3;

/** Show a message. It disappears on its own after `ms` (default 5 s), when dismissed, or when its action is used. */
export function toast(message: string, opts: { action?: Toast['action']; ms?: number } = {}): number {
  const id = nextId++;
  const { toasts } = useToasts.getState();
  // Newest last; drop the oldest when the stack is full so they never pile up the screen.
  useToasts.setState({ toasts: [...toasts, { id, message, action: opts.action }].slice(-MAX_SHOWN) });
  if (typeof window !== 'undefined') window.setTimeout(() => useToasts.getState().dismiss(id), opts.ms ?? 5000);
  return id;
}
