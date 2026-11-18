// Decisions for keeping the open boat in step with its copy in the cloud.
// No Firebase or DOM here, so the rules are unit-tested directly.

/** Largest boat the cloud accepts, in characters of saved text. Mirrors `d.data.size() <= 900000` in firestore.rules. */
export const CLOUD_MAX_CHARS = 900_000;

/** What this browser last knew to be in the cloud for the open boat. */
export interface CloudBase {
  /** When the cloud copy was last written (server time, ms). Changes on every save from any device. */
  rev: number;
  /** Fingerprint of the boat text that was in the cloud at that time. */
  sig: string;
}

/** Short fingerprint of a boat's saved text. Equal text gives an equal fingerprint; that is all it is used for. */
export function signature(data: string): string {
  let h = 5381;
  for (let i = 0; i < data.length; i++) h = ((h << 5) + h + data.charCodeAt(i)) | 0;
  return `${data.length}:${(h >>> 0).toString(36)}`;
}

export interface RemoteCopy {
  exists: boolean;
  rev?: number;
  data?: string;
}

export type RemoteDecision =
  /** Nothing new in the cloud. */
  | 'in-sync'
  /** The cloud copy is our own text (our save landed, or both sides are identical): just note its time. */
  | 'adopt'
  /** Another device changed the boat and nothing here is unsaved: show their version. */
  | 'take-remote'
  /** Another device changed the boat and there are unsaved changes here: the user must choose. */
  | 'conflict'
  /** The boat was deleted from the account elsewhere. */
  | 'deleted';

/**
 * Decide what a fresh look at the cloud copy means.
 * @param localData the open boat as saved text
 * @param base what this browser last knew to be in the cloud (undefined for boats linked before this was tracked)
 * @param lastSent the text of our most recent save, if any, so its arrival is recognised even after further typing
 */
export function onRemote(localData: string, base: CloudBase | undefined, lastSent: string | undefined, remote: RemoteCopy): RemoteDecision {
  if (!remote.exists) return 'deleted';
  if (base && remote.rev === base.rev) return 'in-sync';
  if (remote.data === localData || (lastSent !== undefined && remote.data === lastSent)) return 'adopt';
  const dirty = !base || signature(localData) !== base.sig;
  return dirty ? 'conflict' : 'take-remote';
}

/** Is there anything here that the cloud does not have yet? */
export function isDirty(localData: string, base: CloudBase | undefined): boolean {
  return !base || signature(localData) !== base.sig;
}

const mb = (chars: number) => `${(chars / 1_000_000).toFixed(chars < 100_000 ? 2 : 1)} MB`;

/** Why a boat is too big to save, in words that say what to do about it; or null if it fits. */
export function sizeProblem(data: string, underlayChars = 0): string | null {
  if (data.length <= CLOUD_MAX_CHARS) return null;
  const base = `This boat is too large to save to your account: it is ${mb(data.length)} and the limit is ${mb(CLOUD_MAX_CHARS)}.`;
  return underlayChars > data.length / 2
    ? `${base} The trace-over diagram picture is ${mb(underlayChars)} of that. Replace it with a smaller or simpler picture, or remove it.`
    : `${base} Removing the trace-over diagram, or equipment and drawing parts you no longer need, will bring it down.`;
}

/** Raised when the cloud copy changed, or went away, since this browser last saw it. */
export class CloudConflict extends Error {
  constructor(public remote: RemoteCopy) {
    super(remote.exists ? 'The boat was changed on another device.' : 'The boat was deleted from your account.');
  }
}

/** Turn a save failure into something a boat owner can act on. `retry` says whether trying again can help. */
export function explainSaveError(e: unknown): { message: string; retry: boolean; offline?: boolean } {
  const code = (e as { code?: string } | null)?.code ?? '';
  const text = (e as Error | null)?.message ?? String(e);
  if (code === 'unavailable' || code === 'deadline-exceeded' || /offline|network|Failed to fetch/i.test(text)) {
    return { message: 'No connection to the cloud. Your changes are safe in this browser and will be saved when the connection returns.', retry: true, offline: true };
  }
  if (code === 'permission-denied' || code === 'unauthenticated') {
    return { message: 'Your account was not allowed to save this boat. Sign out and sign in again, then retry.', retry: true };
  }
  if (code === 'resource-exhausted') return { message: 'The cloud storage quota has been reached for now. Your changes are safe in this browser; try again later.', retry: true };
  return { message: `The cloud did not accept the save (${text}). Your changes are safe in this browser.`, retry: true };
}
