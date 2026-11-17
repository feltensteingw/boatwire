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
npm run build      # static site in dist/ — host anywhere, no backend
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
edits autosave about 1.5 s after you stop typing. If you edit the same boat on two devices at once, the last write wins.

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
src/layout/     ELK (elkjs) layered orthogonal layout; manual layout for drawings
src/ui/         React + React Flow canvas, symbols, inspector, reports
```

All standards numbers live in `src/model/standards.ts`. If you hold the ABYC standard,
replace the values there; nothing else hard-codes them.

## Known limitations (v0.1)

- Cable lengths are estimated from zone positions (Boat & zones tab), not measured runs.
- AC is drawn as a one-line diagram (hot/neutral/ground as one cable).
- Bundling/temperature derating beyond engine-space derating is not applied.
- Battery banks are drawn as one symbol with an arrangement label (e.g. 2S2P), not as individual batteries.
