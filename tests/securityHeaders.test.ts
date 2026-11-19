import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { config } from '../src/cloud/config';

// The browser tests serve the policy from firebase.json as an enforcing header whatever its key
// says (vite.config.ts), so only this test notices if the live site stops enforcing it.
const hosting = JSON.parse(readFileSync(new URL('../firebase.json', import.meta.url), 'utf8')) as {
  hosting: { headers: { source: string; headers: { key: string; value: string }[] }[] };
};
const all = hosting.hosting.headers.find((h) => h.source === '**')!.headers;
const cspHeaders = all.filter((h) => h.key.toLowerCase().startsWith('content-security-policy'));
const directives = new Map(
  cspHeaders[0].value
    .split(';')
    .map((d) => d.trim().split(/\s+/))
    .filter((d) => d[0])
    .map(([name, ...sources]) => [name, sources]),
);
const sources = (name: string) => directives.get(name) ?? [];

describe('content-security policy in firebase.json', () => {
  it('is sent as an enforcing header, once', () => {
    expect(cspHeaders.map((h) => h.key)).toEqual(['Content-Security-Policy']);
  });

  it('allows what Google sign-in and Firestore load (Firebase SDK 11)', () => {
    // signInWithPopup loads Google's gapi loader, which loads its iframe module from the same host
    expect(sources('script-src')).toContain('https://apis.google.com');
    // the sign-in helper iframe is <authDomain>/__/auth/iframe
    if (config.authDomain) expect(sources('frame-src')).toContain(`https://${config.authDomain}`);
    // identitytoolkit, securetoken (sign-in, token refresh) and firestore (WebChannel over XHR)
    expect(sources('connect-src')).toContain('https://*.googleapis.com');
    // Google profile photos
    expect(sources('img-src')).toContain('https://*.googleusercontent.com');
  });

  it("allows Firestore's connection-check image, and nothing else on www.google.com", () => {
    // Firestore's WebChannel transport loads www.google.com/images/cleardot.gif when a request
    // fails (network blip). Allowing exactly that file keeps the console free of policy errors.
    const img = sources('img-src');
    expect(img).toContain('https://www.google.com/images/cleardot.gif');
    expect(img.filter((s) => s.includes('www.google.com'))).toEqual(['https://www.google.com/images/cleardot.gif']);
  });

  it('lets PDF import decode JPEG 2000 (WebAssembly) without allowing eval', () => {
    expect(sources('script-src')).toContain("'wasm-unsafe-eval'");
    expect(sources('script-src')).not.toContain("'unsafe-eval'");
    expect(sources('script-src')).not.toContain("'unsafe-inline'");
  });
});
