// What happened to saved data that could not be loaded when the app started.
//
// The unreadable data is never thrown away: it is copied to its own browser-storage key, from
// where the user can download it, before the app carries on with a fresh boat.

import { create } from 'zustand';

export const RECOVERED_KEY = 'boatwire:recovered';

interface Recovery {
  /** Why the saved boat could not be opened, if it could not (this session). */
  problem?: string;
  /** Unreadable data from this or an earlier session is still being kept for download. */
  kept: boolean;
  /** Repairs made to a boat that did open. */
  notes: string[];
  /** Set while changes are not reaching browser storage (e.g. it is full). */
  notSaving?: string;
}

export function recoveredData(): string | null {
  try {
    return localStorage.getItem(RECOVERED_KEY);
  } catch {
    return null;
  }
}

export const useRecovery = create<Recovery>(() => ({ notes: [], kept: recoveredData() !== null }));

/** Keep a copy of data that could not be loaded, and remember why. */
export function stashUnreadable(raw: string, problem: string) {
  try {
    localStorage.setItem(RECOVERED_KEY, raw);
  } catch {
    // storage full or unavailable: nothing more can be done, but still tell the user
  }
  useRecovery.setState({ problem, kept: true });
}

export function clearRecovered() {
  try {
    localStorage.removeItem(RECOVERED_KEY);
  } catch {
    // ignore
  }
  useRecovery.setState({ problem: undefined, notes: [], kept: false });
}
