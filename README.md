# BoatWire — sailboat electrical designer

A browser tool for designing 12 V / 24 V sailboat electrical systems (DC and AC).
You list the equipment aboard. BoatWire generates the **ideal wiring diagram**, with
every fuse, switch, bus and cable sized. It explains each decision and audits
hand-drawn diagrams of existing boats.

> **Safety notice:** wire tables and limits are seeded from widely published,
> ABYC-derived values (see `src/model/standards.ts`). They have **not** been checked
> against the current paid ABYC E-11 text. Have a qualified marine electrician
> review any design before installing it.

## Run

```bash
npm install
npm run dev        # http://localhost:5173
npm test           # engine + layout tests (vitest)
npm run lint       # ESLint (TypeScript + React hook rules)
npm run test:e2e   # browser tests (Playwright) against a production build; uses your installed Chrome
npm run build      # static site in dist/ — host anywhere, no backend (fails if the initial download exceeds the size budget)
npm run size       # re-check the bundle-size budget for an existing dist/
```

Projects autosave in the browser (localStorage). Use **File → Save project file** to
keep a `.boatwire.json` copy.

## Hosting, sign-in and cloud storage (Firebase)

- **Live site:** https://boatwire-1r3u0.web.app (Firebase project `boatwire-1r3u0`)
- **Auth:** Google sign-in (Firebase Authentication)
- **Database:** Cloud Firestore (`nam5`), one document per boat at `users/{uid}/boats/{boatId}`.
  Access rules are in `firestore.rules`: each user can only read and write their own boats.
- **Config:** `.env` holds the Firebase *web* config. It is public by design, and security comes from the rules.
  Blank it out to run fully local with no sign-in.

Signed-in users get **Save to cloud** and **My boats** in the header. Once a boat is saved,
edits autosave about 1.5 s after you stop typing.

**Two devices.** The open boat's cloud copy is watched. A save from another device is shown here
straight away if nothing here is unsaved. If both devices have changes, saving pauses and the user
chooses: use the other version, keep this one, or save this one as a copy. A save never overwrites a
cloud copy this browser has not seen (`saveBoat` in `src/cloud/firebase.ts` runs in a transaction; the
decisions are in `src/cloud/sync.ts`).

**Trying cloud features without an account.** `VITE_CLOUD_FAKE=1 npm run dev` swaps Firebase for an
in-memory stand-in (`src/cloud/fakeCloud.ts`): "Sign in" signs in a made-up user, and boats are kept
in this browser. `window.fakeCloud` can then act as a second device (`remoteSave`, `remoteDelete`,
`offline`). It follows the same size limit and "has it changed since I looked?" rule as the real
thing, but it is not Firestore: check real cloud behaviour on a PR preview.

**Security headers** are set in `firebase.json` for every response: no MIME sniffing, no framing
(`X-Frame-Options: DENY`; Firebase's own `/__/auth/*` sign-in pages are not affected by custom
headers), a strict referrer policy, and device features switched off. A Content-Security-Policy is
sent in **report-only** mode: it blocks nothing yet, but the browser console lists anything it
would block. The browser tests enforce the same policy locally (`E2E_CSP`). Once sign-in and cloud
saving show no reports on the live site, rename the header to `Content-Security-Policy` to enforce it.

| Task | Command |
|------|---------|
| Deploy site manually | `npm run deploy` |
| Deploy Firestore rules/indexes | `npm run deploy:rules` |

**CI/CD (GitHub Actions):** every push to `main` runs the tests, builds and deploys to the live site.
Every pull request gets a 7-day preview URL posted as a PR comment. Both need the repo secret
`FIREBASE_SERVICE_ACCOUNT_BOATWIRE_1R3U0` (see *One-time setup* below).

### One-time setup

1. **Enable Google sign-in:** Firebase console → Authentication → Get started → Sign-in method → Google → Enable.
2. **CI deploy credentials:** run `firebase init hosting:github` in this folder, and enter
   `feltensteingw/boatwire` when it asks for the repository. It creates a deploy-only service
   account and stores it as the GitHub secret above. When it offers to set up workflow files,
   answer **No** to overwriting, because the workflows are already in `.github/workflows/`.

## What it does

| View | Purpose |
|------|---------|
| **Ideal design** | Auto-generated schematic from the equipment list for the active scenario. Show/hide DC, AC, negatives, control wiring and equipment grounds. Toggle wire size / amps / length / voltage-drop / fuse / part labels. Click anything to see its ratings and the rules behind it. |
| **Existing boat** | Draw what's on the boat now. Start from the equipment list, a copy of the ideal design, or a blank canvas. Drag terminal-to-terminal to add wires, then set each wire's size and length. The design is audited live. |
| **Compare** | Scenarios (12 V vs 24 V, AGM vs LiFePO4, capacity) side by side: fuse and cable sizes, copper weight, which components differ, and design notes. |
| **Reports** | Design check, **Upgrade plan** (existing → ideal, ordered safety / recommended / improvement), wire schedule, bill of materials, energy budget. CSV export and print. |

## Architecture

```
src/model/      types, equipment catalog, node (symbol) definitions, standards data
src/engine/     generate.ts  equipment + scenario → ideal Design (topology + sizing)
                audit.ts     rule checks on any Design (net tracing in graph.ts)
                calc.ts      ampacity, voltage drop, protection sizing, run lengths
                reports.ts   wire schedule, BOM, scenario metrics, upgrade plan
                energy.ts    daily load budget and bank sizing
                rules.ts     plain-English "why" text for every rule
src/layout/     ELK (elkjs) layered orthogonal layout, run in a Web Worker; manual layout for drawings
src/ui/         React + React Flow canvas, symbols, inspector, reports
```

**Download size:** the page loads only the app, React and React Flow up front (about 170 KB gzipped).
The layout engine, Firebase, PDF import, the help guide, Compare and Reports load on first use.
`scripts/check-bundle-size.mjs` (run by `npm run build`, so also in CI) fails the build if the
up-front download grows past its budget, so new heavy code should be loaded with a dynamic `import()`.

All standards numbers live in `src/model/standards.ts`. If you hold the ABYC standard,
replace the values there; nothing else hard-codes them.

## Known limitations (v0.1)

- Cable lengths are estimated from zone positions (Boat & zones tab), not measured runs.
- AC is drawn as a one-line diagram (hot/neutral/ground as one cable).
- Bundling/temperature derating beyond engine-space derating is not applied.
- Battery banks are drawn as one symbol with an arrangement label (e.g. 2S2P), not as individual batteries.
