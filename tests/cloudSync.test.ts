import { describe, expect, it } from 'vitest';
import { CLOUD_MAX_CHARS, CloudConflict, explainSaveError, isDirty, onRemote, signature, sizeProblem, type CloudBase } from '../src/cloud/sync';
import { blankProject, exampleProject, isUntouched } from '../src/model/examples';

const base = (rev: number, data: string): CloudBase => ({ rev, sig: signature(data) });

describe('signature', () => {
  it('is equal for equal text and different for different text', () => {
    expect(signature('abc')).toBe(signature('abc'));
    expect(signature('abc')).not.toBe(signature('abd'));
    expect(signature('abc')).not.toBe(signature('abcd'));
    expect(signature('')).toBe('0:' + (5381).toString(36));
  });
});

describe('what a look at the cloud copy means', () => {
  const A = '{"boat":"A"}';
  const B = '{"boat":"B"}';
  const C = '{"boat":"C"}';

  it('nothing new when the cloud copy has not been written since we last looked', () => {
    expect(onRemote(A, base(100, A), undefined, { exists: true, rev: 100, data: A })).toBe('in-sync');
    // even with unsaved changes here
    expect(onRemote(B, base(100, A), undefined, { exists: true, rev: 100, data: A })).toBe('in-sync');
  });

  it('our own save arriving is adopted, even if the user has typed since', () => {
    expect(onRemote(B, base(100, A), B, { exists: true, rev: 200, data: B })).toBe('adopt');
    expect(onRemote(C, base(100, A), B, { exists: true, rev: 200, data: B })).toBe('adopt');
  });

  it('identical text is adopted whoever wrote it', () => {
    expect(onRemote(B, base(100, A), undefined, { exists: true, rev: 200, data: B })).toBe('adopt');
  });

  it('another device changed it and nothing here is unsaved: take their version', () => {
    expect(onRemote(A, base(100, A), undefined, { exists: true, rev: 200, data: B })).toBe('take-remote');
    // after a reload nothing remembers our last save, but the fingerprint still says "clean"
    expect(onRemote(A, base(100, A), undefined, { exists: true, rev: 300, data: C })).toBe('take-remote');
  });

  it('another device changed it and there are unsaved changes here: conflict', () => {
    expect(onRemote(C, base(100, A), undefined, { exists: true, rev: 200, data: B })).toBe('conflict');
  });

  it('a boat linked before changes were tracked is a conflict only if the two differ', () => {
    expect(onRemote(A, undefined, undefined, { exists: true, rev: 200, data: A })).toBe('adopt');
    expect(onRemote(A, undefined, undefined, { exists: true, rev: 200, data: B })).toBe('conflict');
  });

  it('a deleted boat is reported as deleted', () => {
    expect(onRemote(A, base(100, A), undefined, { exists: false })).toBe('deleted');
  });

  it('isDirty compares with what the cloud last had', () => {
    expect(isDirty(A, base(1, A))).toBe(false);
    expect(isDirty(B, base(1, A))).toBe(true);
    expect(isDirty(A, undefined)).toBe(true);
  });
});

describe('boats too large for the cloud', () => {
  it('fits: no problem', () => {
    expect(sizeProblem('x'.repeat(CLOUD_MAX_CHARS))).toBeNull();
    expect(sizeProblem(JSON.stringify(exampleProject()))).toBeNull();
  });

  it('too large: says how large, the limit, and what to do', () => {
    const msg = sizeProblem('x'.repeat(1_250_000), 800_000)!;
    expect(msg).toMatch(/1\.3 MB/);
    expect(msg).toMatch(/limit is 0\.9 MB/);
    expect(msg).toMatch(/trace-over diagram picture is 0\.8 MB/);
    expect(sizeProblem('x'.repeat(1_000_000), 10_000)).toMatch(/Removing the trace-over diagram, or equipment/);
  });
});

describe('explaining a failed save', () => {
  it('recognises no connection', () => {
    for (const e of [{ code: 'unavailable', message: 'x' }, new Error('Failed to get document because the client is offline.'), new TypeError('Failed to fetch')]) {
      const x = explainSaveError(e);
      expect(x.offline, String((e as Error).message)).toBe(true);
      expect(x.message).toMatch(/No connection/);
    }
  });

  it('recognises a permission problem and anything else', () => {
    expect(explainSaveError({ code: 'permission-denied', message: 'Missing or insufficient permissions.' }).message).toMatch(/not allowed to save/);
    const other = explainSaveError(new Error('boom'));
    expect(other.message).toMatch(/did not accept the save \(boom\)/);
    expect(other.offline).toBeUndefined();
  });

  it('a conflict carries the other copy', () => {
    const c = new CloudConflict({ exists: true, rev: 5, data: 'x' });
    expect(c.remote.rev).toBe(5);
    expect(new CloudConflict({ exists: false }).message).toMatch(/deleted/);
  });
});

describe('isUntouched', () => {
  it('is true for a fresh new or example boat, whatever ids it was given', () => {
    expect(isUntouched(blankProject())).toBe(true);
    expect(isUntouched(exampleProject())).toBe(true);
  });

  it('is false once anything has been changed', () => {
    const p = exampleProject();
    p.equipment[0].props.unitAh = 105;
    expect(isUntouched(p)).toBe(false);
    const q = blankProject();
    q.profile.name = 'Sea Otter';
    expect(isUntouched(q)).toBe(false);
    const r = exampleProject();
    r.existing = { id: 'existing', name: 'Existing', systemVoltage: 12, nodes: [], wires: [], findings: [] };
    expect(isUntouched(r)).toBe(false);
  });
});
