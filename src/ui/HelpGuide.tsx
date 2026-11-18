import { useMemo, useState, type ReactNode } from 'react';
import { makeNode } from '../model/nodeDefs';
import type { NodeType } from '../model/types';
import { useHelp } from './Help';
import { Modal } from './Modal';
import { Icon } from './symbols';

// ---------------------------------------------------------------- content

const W = ({ c, children }: { c: string; children: ReactNode }) => (
  <span className="g-wire">
    <i style={{ background: `var(--w-${c})` }} className={c === 'sig' ? 'dash' : ''} />
    {children}
  </span>
);

const SYMBOLS: [NodeType, string, string, Record<string, unknown>?][] = [
  ['battery', 'Battery / bank', 'Sublabel shows how many batteries and their size.'],
  ['fuse', 'Fuse', 'Class T, MRBF, ANL, MIDI or ATC blade, chosen by current and fault level.'],
  ['breaker', 'Circuit breaker', 'Resettable protection, used for motors, PV and AC.'],
  ['switch', 'Battery switch', 'On/off isolation for a bank.'],
  ['bus-pos', 'Bus bar', 'Common connection point: red positive, black negative, green ground.'],
  ['dc-panel', 'Panel / fuse block', 'Each row is one circuit with its own breaker or fuse.'],
  ['shunt', 'Battery monitor shunt', 'Measures every amp in and out of the bank.'],
  ['acr', 'Charging relay (ACR)', 'Joins two banks only while charging.'],
  ['isolator', 'Battery isolator', 'One-way diodes/FETs: one charger, several banks.'],
  ['dcdc', 'DC-DC charger / converter', 'Charges one bank from another with the right profile.'],
  ['mppt', 'Solar MPPT controller', 'Converts panel voltage down to battery voltage.'],
  ['alternator', 'Alternator', 'Engine-driven charging.'],
  ['regulator', 'Regulator / BMS', 'Smart control box: field control, cell monitoring.'],
  ['apd', 'Alternator protection', 'Absorbs the spike if a lithium BMS disconnects.'],
  ['inverter-charger', 'Inverter / charger', 'DC ↔ AC. Makes mains power from batteries and charges them on shore.'],
  ['shore-inlet', 'Shore inlet', 'Where the shore cord plugs in.'],
  ['elci', 'Main breaker + ELCI', 'Trips on leakage that could electrocute swimmers.'],
  ['galvanic-isolator', 'Galvanic isolator', 'Blocks stray DC on the shore ground that eats zincs.'],
  ['selector', 'Source selector', 'Only one AC source can feed the panel at a time.'],
  ['contactor', 'Contactor / solenoid', 'Heavy-duty relay switched from the helm or BMS.'],
  ['load', 'DC load', 'Lights show ⊗, motors show M, others show a short code.'],
];

function SymbolGallery() {
  const nodes = useMemo(() => SYMBOLS.map(([t, label, why]) => ({ n: makeNode(t, `g-${t}`, label), label, why })), []);
  return (
    <div className="g-symbols">
      {nodes.map(({ n, label, why }) => (
        <div key={n.id} className="g-sym">
          <span className="g-icon">
            <Icon n={n} />
          </span>
          <div>
            <b>{label}</b>
            <div className="hint">{why}</div>
          </div>
        </div>
      ))}
    </div>
  );
}

interface Section {
  id: string;
  title: string;
  /** extra words to match in search */
  keywords: string;
  body: ReactNode;
}

const SECTIONS: Section[] = [
  {
    id: 'start',
    title: 'Getting started',
    keywords: 'quick start begin new boat example overview intro',
    body: (
      <>
        <p>
          BoatWire draws the electrical system for a sailboat. You list what's aboard: batteries, engine, solar, chargers, lights, pumps, electronics, AC appliances. BoatWire then designs the ideal wiring: wire sizes, fuses, switches, buses and
          charging. It explains every choice and flags anything unsafe.
        </p>
        <h4>Quick start</h4>
        <ol>
          <li>
            <b>Start from the example or a blank boat.</b> The example 40 ft sloop is loaded the first time. Use <b>File → New boat</b> to start fresh.
          </li>
          <li>
            <b>Describe the boat.</b> On the left, open <b>Boat &amp; zones</b> and set system voltage, AC standard and where things are. Locations decide cable lengths.
          </li>
          <li>
            <b>List your equipment.</b> On the <b>Equipment</b> tab use <b>+ Add equipment…</b>. Click any item to edit its size, location and usage.
          </li>
          <li>
            <b>Read the ideal design.</b> The diagram updates instantly. Click any component or wire to see its ratings and <i>why it's wired that way</i>.
          </li>
          <li>
            <b>Check the Design check panel</b> on the right for errors and warnings, such as an undersized battery bank.
          </li>
          <li>
            <b>Try what-ifs</b> in <b>Compare</b>, for example 24 V or lithium. If you're upgrading a boat, draw what you have under <b>Existing boat</b> to get an upgrade plan.
          </li>
        </ol>
        <p className="hint">Tip: hover over almost any button or option for a short explanation. Press <kbd>?</kbd> anytime to open this guide.</p>
      </>
    ),
  },
  {
    id: 'equipment',
    title: 'Equipment list',
    keywords: 'add equipment battery engine solar load watts hours duty critical 24v unswitched always on bilge energy budget ah per day',
    body: (
      <>
        <p>Everything aboard is listed on the left, grouped by type. BoatWire designs the wiring from this list.</p>
        <ul>
          <li>
            <b>+ Add equipment…</b> adds an item with typical values. Click an item to open its settings, and click again to close.
          </li>
          <li>
            <b>Location</b> is the zone the item lives in, such as bow, galley or masthead. It sets cable length, which sets wire size.
          </li>
          <li>
            <b>Power draw (W)</b> and <b>Hours per day</b> drive the energy budget. <b>Duty cycle</b> covers things that cycle on and off, like a fridge compressor.
          </li>
          <li>
            <b>Critical circuit</b> holds the wire to 3% voltage drop instead of 10%. Use it for nav lights, bilge pumps and electronics.
          </li>
          <li>
            <b>Runs on 24 V</b>: on a 24 V boat, 12 V-only items are fed through a 24→12 V converter and a 12 V sub-panel.
          </li>
          <li>
            <b>Unswitched (always on)</b> feeds the item from the battery side of the main switch, so it works with the boat shut down. Bilge pumps default to this.
          </li>
          <li>
            <b>Duplicate</b> is handy for two identical pumps. <b>Remove</b> deletes the item.
          </li>
        </ul>
        <h4>Energy budget box</h4>
        <p>
          Shows your daily use in amp-hours, the house bank size and its usable part, and the recommended size. The recommendation covers about two days without charging at a safe depth of discharge: about 50% for lead-acid and 80% for lithium. It turns orange when the bank is too
          small.
        </p>
      </>
    ),
  },
  {
    id: 'boat',
    title: 'Boat & zones (cable lengths)',
    keywords: 'zones location length aft rise system voltage ac standard battery location panel location',
    body: (
      <>
        <ul>
          <li>
            <b>DC system voltage</b>: 12 V or 24 V. Scenarios can override it, so you can compare both without changing anything here.
          </li>
          <li>
            <b>AC standard</b>: 120 V / 60 Hz (North America) or 230 V / 50 Hz. This sets AC cable sizes and outlet types.
          </li>
          <li>
            <b>Battery / main bus location</b> and <b>Main panel location</b> are the two hubs every circuit is measured from.
          </li>
          <li><b>Units</b>: feet and AWG, or metres and mm². In metric, each wire shows the standard mm² cable to buy (the next size up from the AWG size it was worked out as), and lengths are in metres. Changing units never changes a result.</li>
        </ul>
        <h4>Zones</h4>
        <p>
          Each zone has a distance <b>Aft (ft)</b> from the bow and a <b>Rise (ft)</b> for extra vertical or routing distance (the masthead is about 50 ft up). Cable length is the distance between zones, plus 20% for routing along the hull. Wire size depends on length, so
          rough but honest numbers matter. Add zones for anything special, like a fly bridge or a radar arch.
        </p>
      </>
    ),
  },
  {
    id: 'ideal',
    title: 'The ideal design',
    keywords: 'generated automatic why wired inspector click component wire ratings part',
    body: (
      <>
        <p>
          The <b>Ideal design</b> tab is generated from your equipment list using marine wiring practice, based on ABYC E-11 and related standards. It includes:
        </p>
        <ul>
          <li>
            The battery banks, each with its main fuse within 7 in of the terminal (Class T for lithium), a battery switch and a monitor shunt.
          </li>
          <li>Positive and negative bus bars, an always-on fuse block for bilge pumps, and the DC panel with one breaker per circuit.</li>
          <li>Heavy loads like the windlass, thruster and inverter fed straight from the bus with their own protection.</li>
          <li>
            Optional dedicated batteries for the windlass, thruster, winch or refrigeration. Open the equipment and click <b>+ Add a dedicated battery</b> (or add a battery bank and pick its role). The equipment then draws its power from that battery, is switched from the house DC panel through a relay, and the battery is recharged from the house bank by a DC-DC charger.
          </li>
          <li>Charging: alternator, solar, wind, hydro and shore charger, each fused at the battery end, plus the right way to share charge between banks.</li>
          <li>The AC side: inlet, main breaker with ELCI, galvanic isolator, source selector, AC panel, and the AC ground bonded to DC negative.</li>
        </ul>
        <p>
          <b>Click anything</b> on the diagram. The panel on the right shows its rating, the suggested part, its connections and a plain-English <b>Why it's wired this way</b>. Click a wire to see its size, length, current and voltage drop, and how the size was chosen.
        </p>
        <p className="hint">The ideal design can't be edited directly; change the equipment list instead. To draw your own wiring, use Existing boat.</p>
      </>
    ),
  },
  {
    id: 'diagram',
    title: 'Reading the diagram',
    keywords: 'symbols legend wire colours colors thickness labels badge zoom pan minimap',
    body: (
      <>
        <h4>Wire colours</h4>
        <div className="g-wires">
          <W c="pos">DC positive</W>
          <W c="neg">DC negative (black or yellow on the boat)</W>
          <W c="ac">AC circuit, drawn as one line per cable</W>
          <W c="gnd">AC grounding / bonding (green)</W>
          <W c="sig">Control / signal (dashed)</W>
        </div>
        <p>Thicker lines are heavier cables. A label like “2× 4/0” means two cables in parallel. A label with “fuse 300 A” means a hidden fuse sits in that wire (see Show / hide).</p>
        <h4>Badges</h4>
        <p>A red, orange or blue dot on a component means the Design check found an error, warning or note about it. Click the component to read it.</p>
        <h4>Moving around</h4>
        <p>Scroll or pinch to zoom, and drag the background to pan. The minimap at the bottom right shows where you are. Use the + / − / ⤢ buttons to zoom or fit everything. <b>Re-arrange</b> re-runs the automatic layout.</p>
        <h4>Symbols</h4>
        <SymbolGallery />
      </>
    ),
  },
  {
    id: 'layers',
    title: 'Show / hide and labels',
    keywords: 'layers dc ac negatives panel loads fuses control grounds labels wire size amps length vdrop voltage drop fuse rating parts reset clutter simplify',
    body: (
      <>
        <p>The bar above the diagram controls what's drawn, so you can go from the whole system down to just the part you care about. Nothing is deleted; it's only hidden.</p>
        <table className="g-table">
          <tbody>
            <tr><td><b>DC / AC</b></td><td>Show the battery system, the mains system, or both. At least one stays on.</td></tr>
            <tr><td><b>Negatives</b></td><td><i>All</i> draws every negative wire. <i>Buses only</i> hides the many short load returns. <i>Hide</i> shows positives only; a ⏚ mark shows where a negative was hidden.</td></tr>
            <tr><td><b>Panel loads</b></td><td>Off collapses everything fed from the DC panel (lights, fans, fridge…) into a “12 circuits hidden” summary on the panel.</td></tr>
            <tr><td><b>Fuses</b></td><td>Off draws wires straight through inline fuses. The wire label still says which fuse is there.</td></tr>
            <tr><td><b>Control</b></td><td>Thin dashed signal wires: BMS, regulator sensing, relay triggers, helm switches.</td></tr>
            <tr><td><b>Equip. grounds</b></td><td>The green safety-ground wire to each AC appliance.</td></tr>
          </tbody>
        </table>
        <h4>Labels</h4>
        <p>Choose what's printed on each wire: <b>Wire size</b> (AWG), <b>Amps</b>, <b>Length</b> (one way, ft), <b>V-drop</b> (% at full current), <b>Fuse rating</b>, and suggested <b>Parts</b> under each component. <b>Reset</b> restores the defaults.</p>
      </>
    ),
  },
  {
    id: 'check',
    title: 'Design check (errors & warnings)',
    keywords: 'findings errors warnings notes audit rules fix design check',
    body: (
      <>
        <p>BoatWire checks every design against its rules, both the generated ideal and anything you draw yourself:</p>
        <ul>
          <li>
            <b className="g-err">Errors</b> are safety problems: an unfused battery cable, wire too small for its fuse, lithium paralleled with lead-acid, an AC source without a main breaker.
          </li>
          <li>
            <b className="g-warn">Warnings</b> are things that will work badly or wear out early: excessive voltage drop, an undersized bank, a diode isolator with a stock regulator.
          </li>
          <li>
            <b className="g-info">Notes</b> are information, such as where BoatWire made a substitution.
          </li>
        </ul>
        <p>Click a finding to highlight the parts involved. Each finding has a suggested fix and an explanation of the rule behind it.</p>
      </>
    ),
  },
  {
    id: 'charging',
    title: 'Charging choices explained',
    keywords: 'charge splitting acr isolator diode fet excitation sense compensation dc-dc charger relay engine run d+ alternator regulator lithium lifepo4 bms apd external regulator start battery',
    body: (
      <>
        <p>
          One alternator usually has to charge two banks: house and engine start. They must never simply be wired together, or a flat house bank would stop you starting the engine. On the engine, <b>Charge splitting</b> picks how this is done:
        </p>
        <table className="g-table">
          <tbody>
            <tr><td><b>Automatic</b> (recommended)</td><td>Picks an ACR for lead-acid and a DC-DC charger for lithium.</td></tr>
            <tr><td><b>ACR / voltage-sensitive relay</b></td><td>Joins the banks whenever either is being charged (by any source), and separates them when voltage falls. Simple and cheap.</td></tr>
            <tr><td><b>Charging relay (engine-run / D+)</b></td><td>Joins the banks only while the engine runs (the alternator's D+ signal). Predictable, but solar or shore charging won't reach the start battery through it.</td></tr>
            <tr><td><b>FET isolator</b></td><td>Electronic one-way valves: one alternator feeds both banks, which are never connected to each other. Almost no voltage loss.</td></tr>
            <tr><td><b>Diode isolator</b></td><td>Same idea, but loses ~0.7 V. A stock regulator must be compensated, or the batteries are always undercharged. <b>Diode isolator compensation</b> picks how: a thin wire from the isolator's "E" terminal to the alternator's excitation terminal (the default), or the alternator's sense lead moved to the house bus. Shown for older boats that have one.</td></tr>
          </tbody>
        </table>
        <h4>Lithium (LiFePO4)</h4>
        <p>
          Lithium needs its own charge profile and must never be paralleled with lead-acid. If its BMS disconnects while the alternator is charging, the voltage spike can destroy the alternator. So for a lithium house bank, BoatWire either charges the lead-acid start battery
          from the alternator and feeds the house bank through a <b>DC-DC charger</b>, or, with an <b>external regulator</b>, charges lithium directly with an <b>alternator protection device</b>. Relay and isolator options are ignored for lithium, with a note explaining
          why.
        </p>
      </>
    ),
  },
  {
    id: 'compare',
    title: 'Scenarios & Compare',
    keywords: 'scenario what if compare 12v 24v voltage chemistry lithium capacity cost weight copper',
    body: (
      <>
        <p>
          A <b>scenario</b> is a what-if version of your boat. It uses the same equipment but can change the <b>system voltage</b>, <b>house battery chemistry</b> or <b>house capacity</b> (in Ah at the system voltage). The example has three: as specified, 12 V lithium,
          and 24 V lithium.
        </p>
        <ul>
          <li>
            The <b>Scenario</b> menu at the top picks which one the diagram shows.
          </li>
          <li>
            <b>Compare</b> puts all scenarios side by side: house bank, main fuse and cable, largest cable, estimated copper weight, total cable length, component count, errors and warnings. The best value in each row is highlighted, and components that exist in only some scenarios are listed.
          </li>
          <li>
            <b>+ New scenario</b> adds one; edit its settings in the column header. <b>View diagram →</b> opens it.
          </li>
        </ul>
      </>
    ),
  },
  {
    id: 'existing',
    title: 'Existing boat & upgrade plan',
    keywords: 'existing draw wire terminal connect palette add component place equipment upgrade plan changes delete upload trace underlay photo scan pdf image diagram select several box copy paste duplicate nudge arrow move wire end note label text quick add drag',
    body: (
      <>
        <p>Use this when you're improving a boat you already own. Draw the wiring as it really is; BoatWire checks it and lists the changes needed to reach the ideal design.</p>
        <h4>Four ways to start</h4>
        <ul>
          <li><b>From my equipment list</b>: places your batteries, chargers and loads, and you draw the wires, fuses and switches.</li>
          <li><b>From the ideal design</b>: copies the ideal design, and you delete or change what's different. This is fastest for a fairly standard boat.</li>
          <li><b>Blank canvas</b>: you add everything yourself.</li>
          <li><b>Trace over my wiring diagram</b>: upload a photo, scan or PDF of your boat's diagram and draw on top of it.</li>
        </ul>
        <h4>Tracing over your own diagram</h4>
        <ul>
          <li>Use <b>⤒ Trace over my diagram…</b> at the top right of the canvas to upload a photo, scan or PDF. A PDF uses its first page. The picture shows faded behind your drawing.</li>
          <li>While it is unlocked, drag it to move it and drag the corner handle to resize it. Click <b>Lock</b> when it lines up, so clicks and panning go to your drawing.</li>
          <li>The slider sets how faint the picture is, the checkbox hides it, <b>Fit</b> zooms to it, and <b>Replace</b> swaps in a new file in the same place.</li>
          <li>BoatWire does not read the picture. It is only a guide, so the checks and upgrade plan use the components and wires you draw.</li>
          <li>The picture is shrunk and saved with your project, so it is included in cloud saves and project files.</li>
        </ul>
        <h4>Drawing</h4>
        <ul>
          <li>The <b>Quick add</b> strip has the parts most drawings need many of. Click one to add it in the middle of the view, or drag it to where it goes. <b>+ Add component…</b> lists every kind of component. <b>+ Place equipment</b> adds items from your list that aren't drawn yet.</li>
          <li>Drag from one terminal dot to another to draw a wire. Red dots are positive, black are negative, orange are AC, green are ground, and blue are signal.</li>
          <li>Click a component to set its rating, chemistry or capacity. Panels and bus bars can have studs or circuits added.</li>
          <li>A new wire opens on the right so you can set its real size, length and type, and whether it runs through the hot engine space. Click any wire to change these later.</li>
          <li>A dotted wire labelled <b>size?</b> has no size yet. BoatWire cannot check it, and the status stays amber until every power wire has a size.</li>
          <li>To move a wire to a different terminal, click the wire, then drag the round grip beside either end onto the new terminal. BoatWire refuses a move that would join, say, positive to negative.</li>
          <li>A <b>Note</b> is free text for anything BoatWire has no symbol for. Notes show on the drawing and in exported pictures. They are not part of the checks or the reports.</li>
          <li>Press <kbd>Delete</kbd> to remove the selection. <b>Auto-arrange</b> tidies the layout.</li>
        </ul>
        <h4>Working on several components at once</h4>
        <ul>
          <li>Hold <kbd>Shift</kbd> and drag on the empty canvas to draw a box around components, or <kbd>Shift</kbd>-click them one by one. On a touch screen, turn on <b>Select area</b> at the top left of the canvas and drag a box.</li>
          <li>Drag any one of the selected components to move them all. The arrow keys nudge them one grid square; with <kbd>Shift</kbd>, five.</li>
          <li><kbd>Ctrl</kbd>/<kbd>⌘</kbd> + <kbd>D</kbd> duplicates the selection, including the wires between the selected components. <kbd>Ctrl</kbd>/<kbd>⌘</kbd> + <kbd>C</kbd> and <kbd>V</kbd> copy and paste. A copy is a new generic part: it is not linked to your equipment list.</li>
          <li><kbd>Delete</kbd> removes everything selected, and one undo brings it all back.</li>
        </ul>
        <h4>Upgrade plan</h4>
        <p>The status button (e.g. “2 errors · 3 warnings → Upgrade plan”) opens <b>Reports → Upgrade plan</b>. The plan is grouped into <b>Safety: fix first</b>, <b>Recommended</b>, and <b>Improvements</b> that bring you to the ideal design.</p>
      </>
    ),
  },
  {
    id: 'reports',
    title: 'Reports',
    keywords: 'reports wire schedule bill of materials bom energy budget csv print shopping list full report electrician pdf',
    body: (
      <>
        <table className="g-table">
          <tbody>
            <tr><td><b>Design check</b></td><td>All findings for the chosen design.</td></tr>
            <tr><td><b>Upgrade plan</b></td><td>Prioritized changes from your existing wiring to the ideal.</td></tr>
            <tr><td><b>Wire schedule</b></td><td>Every conductor: from, to, size, length, current, voltage drop, protection. Hand it to whoever is pulling cable.</td></tr>
            <tr><td><b>Bill of materials</b></td><td>A shopping list: cable by size and total length, fuses, breakers, bus bars, lugs, and so on.</td></tr>
            <tr><td><b>Energy budget</b></td><td>Daily consumption per item, and how the house bank and charging compare.</td></tr>
            <tr><td><b>Full report</b></td><td>All of the above plus the wiring diagram, the date, the BoatWire version and the standards notice, in one printable document for your electrician.</td></tr>
          </tbody>
        </table>
        <p>Switch between <b>Ideal</b> and <b>Existing</b> at the top. <b>Download CSV</b> opens in Excel or Google Sheets. <b>Print</b> gives a clean paper copy.</p>
      </>
    ),
  },
  {
    id: 'saving',
    title: 'Saving, sign-in & files',
    keywords: 'save cloud sign in google my boats file open project json autosave local',
    body: (
      <>
        <ul>
          <li>Your work is always saved in this browser automatically, even without signing in.</li>
          <li>
            <b>Sign in</b> with Google, then <b>Save to cloud</b> to keep the boat in your account. After that, changes save automatically (about every second and a half). Use <b>My boats</b> to open or delete saved boats from any computer.
          </li>
          <li>
            <b>File → Save project file</b> downloads the boat as a file you can keep or send to someone. <b>Open project…</b> loads one back.
          </li>
          <li>
            <b>File → New boat</b> and <b>Load example boat</b> replace what's on screen. Save first if you want to keep it.
          </li>
        </ul>
      </>
    ),
  },
  {
    id: 'export',
    title: 'Exporting & printing',
    keywords: 'export png svg image print pdf diagram share electrician full report',
    body: (
      <ul>
        <li><b>File → Export diagram (PNG)</b> saves a picture of the current diagram, and <b>SVG</b> saves a scalable drawing for printing large or editing.</li>
        <li><b>File → Wire schedule (CSV)</b> and <b>Bill of materials (CSV)</b> save spreadsheets.</li>
        <li><b>File → Full report for an electrician</b> (or <b>Reports → Full report</b>) puts the diagram, design check, upgrade plan, wire schedule, bill of materials and energy budget on one page. Click <b>Print / Save as PDF</b> and choose “Save as PDF” to get a single file to email.</li>
        <li><b>File → Print current view</b>, or <b>Print</b> in Reports, prints without the toolbars. Choose “Save as PDF” in the print dialog to make a PDF.</li>
        <li>Exports use the current colour scheme. Switch to Light first for a white background.</li>
      </ul>
    ),
  },
  {
    id: 'themes',
    title: 'Colour schemes',
    keywords: 'theme colour color dark light night red blueprint chart high contrast',
    body: (
      <>
        <p>Use the 🎨 menu at the top to pick a look. The wire colour meanings never change.</p>
        <ul>
          <li><b>Auto</b> follows your computer's light or dark setting.</li>
          <li><b>Nautical chart</b>: warm paper tones.</li>
          <li><b>Night watch (red)</b>: dim reds only, to keep your night vision at the nav station.</li>
          <li><b>Blueprint</b>: white on blue.</li>
          <li><b>High contrast</b>: for bright sunlight or low vision.</li>
        </ul>
      </>
    ),
  },
  {
    id: 'offline',
    title: 'Working offline & installing',
    keywords: 'offline no connection signal internet install app home screen pwa tablet phone update new version',
    body: (
      <>
        <p>After you have opened BoatWire once, it works with no connection: at the dock, at anchor, or in a boatyard shed. Your boat is saved on the device you are using.</p>
        <ul>
          <li>The word <b>Offline</b> appears in the header while there is no connection. Everything except signing in and cloud saving carries on working.</li>
          <li>If the boat is saved to your account, changes made offline are sent when the connection returns.</li>
          <li><b>Install it as an app:</b> in Chrome or Edge use the install icon in the address bar (or the menu → “Install BoatWire”). On an iPad or iPhone use Share → “Add to Home Screen”. It then opens in its own window like any other app.</li>
          <li>When a new version is ready you are told, with a <b>Reload</b> button. Nothing changes until you reload or next open the app.</li>
        </ul>
        <p className="hint">The copy on the device is only as safe as the device. Sign in and save to the cloud, or use <b>File → Save project file</b>, to keep a second copy.</p>
      </>
    ),
  },
  {
    id: 'shortcuts',
    title: 'Keyboard & mouse',
    keywords: 'keyboard shortcuts mouse delete zoom pan help undo redo mistake restore touch tablet phone ipad tap hold mobile',
    body: (
      <table className="g-table">
        <tbody>
          <tr><td><kbd>?</kbd></td><td>Open this guide</td></tr>
          <tr><td><kbd>Esc</kbd></td><td>Close the guide or dialogs; clear the selection on the drawing</td></tr>
          <tr><td><kbd>Ctrl</kbd>/<kbd>⌘</kbd> + <kbd>Z</kbd></td><td>Undo the last change. The ↶ ↷ buttons in the header do the same and say what they will undo.</td></tr>
          <tr><td><kbd>Ctrl</kbd>/<kbd>⌘</kbd> + <kbd>Shift</kbd> + <kbd>Z</kbd></td><td>Redo (also <kbd>Ctrl</kbd> + <kbd>Y</kbd>)</td></tr>
          <tr><td><kbd>Delete</kbd> / <kbd>Backspace</kbd></td><td>Remove the selected components and wires (Existing boat)</td></tr>
          <tr><td><kbd>Shift</kbd> + drag background</td><td>Draw a box to select several components (Existing boat). <kbd>Shift</kbd>-click adds or removes one.</td></tr>
          <tr><td>Arrow keys</td><td>Nudge the selected components one grid square; with <kbd>Shift</kbd>, five</td></tr>
          <tr><td><kbd>Ctrl</kbd>/<kbd>⌘</kbd> + <kbd>D</kbd></td><td>Duplicate the selected components</td></tr>
          <tr><td><kbd>Ctrl</kbd>/<kbd>⌘</kbd> + <kbd>C</kbd> / <kbd>V</kbd></td><td>Copy and paste components</td></tr>
          <tr><td><kbd>Ctrl</kbd>/<kbd>⌘</kbd> + <kbd>A</kbd></td><td>Select every component on the drawing</td></tr>
          <tr><td>Scroll / pinch</td><td>Zoom the diagram</td></tr>
          <tr><td>Drag background</td><td>Pan</td></tr>
          <tr><td>Drag terminal → terminal</td><td>Draw a wire (Existing boat). Clicking or tapping one terminal and then another does the same.</td></tr>
          <tr><td>Hover</td><td>Explanation of most buttons and options</td></tr>
          <tr><td>Press and hold (touch screens)</td><td>The same explanation, without pressing the button. Tapping the small <b>?</b> beside a field explains that field.</td></tr>
          <tr><td>Bar at the bottom (tablets and phones)</td><td>Switches between the equipment list, the diagram and the details panel, which slide over the diagram on smaller screens. Tapping a component opens its details.</td></tr>
        </tbody>
      </table>
    ),
  },
  {
    id: 'limits',
    title: 'Safety & limitations',
    keywords: 'safety abyc standards disclaimer electrician verify limitations',
    body: (
      <>
        <p className="hint caution">
          BoatWire is a design aid, not a substitute for a qualified marine electrician. Its wire tables and limits are based on widely published ABYC-derived values and have <b>not</b> been verified against the current ABYC E-11 text. Have any design reviewed before
          you install it, especially AC wiring and lithium systems.
        </p>
        <ul>
          <li>Cable lengths are estimates from your zones. Measure real runs before buying cable.</li>
          <li>Current draws are typical values. Use the figures from your equipment's manuals.</li>
          <li>Part suggestions are generic types, not endorsements. Check ratings on the actual product.</li>
        </ul>
      </>
    ),
  },
];

// ---------------------------------------------------------------- the guide

function textOf(node: ReactNode): string {
  if (node == null || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join(' ');
  if (typeof node === 'object' && 'props' in node) return textOf((node as { props: { children?: ReactNode } }).props.children);
  return '';
}

/** The guide dialog. Loaded on first open (see HelpGuide in Help.tsx) to keep it out of the initial download. */
export default function HelpGuidePanel() {
  const topic = useHelp((s) => s.topic);
  const open = useHelp((s) => s.open);
  const close = useHelp((s) => s.close);
  const [q, setQ] = useState('');
  const index = useMemo(() => SECTIONS.map((s) => ({ s, text: `${s.title} ${s.keywords} ${textOf(s.body)}`.toLowerCase() })), []);
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  const shown = words.length ? index.filter((x) => words.every((w) => x.text.includes(w))).map((x) => x.s) : SECTIONS;

  if (!topic) return null;
  const current = shown.find((s) => s.id === topic) ?? shown[0];
  return (
    <Modal label="BoatWire how-to guide" className="guide" onClose={close}>
        <div className="modal-head">
          <h3>How to use BoatWire</h3>
          <button className="icon" onClick={close} aria-label="Close">
            ×
          </button>
        </div>
        <div className="guide-body">
          <nav className="guide-toc">
            <input type="search" placeholder="Search the guide…" value={q} onChange={(e) => setQ(e.target.value)} autoFocus />
            {shown.map((s) => (
              <button key={s.id} className={current?.id === s.id ? 'on' : ''} onClick={() => open(s.id)}>
                {s.title}
              </button>
            ))}
            {!shown.length && <p className="hint">Nothing matches “{q}”.</p>}
          </nav>
          <article className="guide-page">
            {current && (
              <>
                <h2>{current.title}</h2>
                {current.body}
                <GuideNav id={current.id} list={shown} go={open} />
              </>
            )}
          </article>
        </div>
    </Modal>
  );
}

function GuideNav({ id, list, go }: { id: string; list: Section[]; go: (id: string) => void }) {
  const i = list.findIndex((s) => s.id === id);
  const prev = list[i - 1];
  const next = list[i + 1];
  return (
    <div className="guide-nav">
      {prev ? <button onClick={() => go(prev.id)}>← {prev.title}</button> : <span />}
      {next && (
        <button className="primary" onClick={() => go(next.id)}>
          {next.title} →
        </button>
      )}
    </div>
  );
}
