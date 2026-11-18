import { useMemo, useState } from 'react';
import { energyBudget } from '../engine/energy';
import { billOfMaterials, changeList, findingCounts, wireSchedule } from '../engine/reports';
import { ruleInfo, STANDARDS_NOTICE } from '../engine/rules';
import { activeScenario } from '../engine/scenario';
import { acVoltsOf, useExisting, useFindings, useIdeal } from '../state/derived';
import type { Design } from '../model/types';
import { useStore, type ReportTab } from '../state/store';
import { Diagram } from './Diagram';
import { downloadText, toCsv } from './download';
import { FindingsList } from './Findings';

const TABS: { id: ReportTab; label: string; tip: string }[] = [
  { id: 'findings', label: 'Design check', tip: 'Every error, warning and note for the chosen design, with suggested fixes.' },
  { id: 'changes', label: 'Upgrade plan', tip: 'Prioritized changes to take your existing wiring to the ideal design.' },
  { id: 'wires', label: 'Wire schedule', tip: 'Every conductor: from, to, size, length, current, voltage drop and protection.' },
  { id: 'bom', label: 'Bill of materials', tip: 'Shopping list: cable by size and length, fuses, breakers, bus bars and other parts.' },
  { id: 'energy', label: 'Energy budget', tip: 'Daily consumption per item compared with house bank capacity and charging.' },
  {
    id: 'full',
    label: 'Full report',
    tip: 'Everything an electrician needs on one printable page: diagram, design check, upgrade plan, wire schedule, bill of materials and energy budget. Print, then choose “Save as PDF” to email it.',
  },
];

export function Reports() {
  const tab = useStore((s) => s.reportTab);
  const setTab = useStore((s) => s.setReportTab);
  const which = useStore((s) => s.reportDesign);
  const setWhich = useStore((s) => s.setReportDesign);
  const project = useStore((s) => s.project);
  const ideal = useIdeal();
  const existing = useExisting();
  const design = which === 'existing' && existing ? existing : ideal;
  const findings = useFindings(design);
  const scen = activeScenario(project);
  const showSel = tab !== 'energy' && tab !== 'changes';
  return (
    <div className="reports">
      <div className="report-tabs">
        {TABS.map((t) => (
          <button key={t.id} className={tab === t.id ? 'on' : ''} onClick={() => setTab(t.id)} data-tip={t.tip}>
            {t.label}
          </button>
        ))}
        <span className="spacer" />
        {showSel && (
          <div className="seg small">
            <button className={which === 'ideal' ? 'on' : ''} onClick={() => setWhich('ideal')}>
              Ideal ({scen?.name ?? 'base'})
            </button>
            <button className={which === 'existing' ? 'on' : ''} disabled={!existing} onClick={() => setWhich('existing')} data-tip={existing ? 'Show reports for your existing wiring.' : 'Draw your existing system first (Existing boat tab).'}>
              Existing
            </button>
          </div>
        )}
        <button className={tab === 'full' ? 'primary' : ''} onClick={() => window.print()} data-tip={tab === 'full' ? 'Print the full report. Choose “Save as PDF” in the print dialog to make a PDF you can email.' : 'Print this report.'}>
          {tab === 'full' ? 'Print / Save as PDF' : 'Print'}
        </button>
      </div>
      <div className="report-body">
        {tab === 'findings' && <FindingsList findings={findings} design={design === ideal ? 'ideal' : 'existing'} />}
        {tab === 'changes' && <Changes />}
        {tab === 'wires' && <WireTable />}
        {tab === 'bom' && <Bom />}
        {tab === 'energy' && <Energy />}
        {tab === 'full' && <FullReport />}
      </div>
    </div>
  );
}

function useReportDesign() {
  const which = useStore((s) => s.reportDesign);
  const ideal = useIdeal();
  const existing = useExisting();
  return which === 'existing' && existing ? existing : ideal;
}

function WireTable() {
  const design = useReportDesign();
  const rows = useMemo(() => wireSchedule(design), [design]);
  const csv = () =>
    downloadText(
      'wire-schedule.csv',
      toCsv([
        ['Circuit', 'From', 'To', 'Type', 'Colour', 'Size (AWG)', 'mm²', 'Length (ft)', 'Current (A)', 'Protection', 'V drop %', 'Limit %'],
        ...rows.map((r) => [r.circuit, r.from, r.to, r.kind, r.color, r.gauge, r.mm2, r.lengthFt, r.amps?.toFixed(1), r.protection, r.vdrop?.toFixed(2), r.vdropLimit]),
      ]),
    );
  return (
    <div>
      <div className="report-actions">
        <span className="hint">{rows.length} conductors · lengths are one-way estimates from zone distances</span>
        <button onClick={csv}>Download CSV</button>
      </div>
      <table className="grid">
        <thead>
          <tr>
            <th>Circuit</th>
            <th>From</th>
            <th>To</th>
            <th>Colour</th>
            <th>Size</th>
            <th className="r">Length</th>
            <th className="r">Current</th>
            <th>Protection</th>
            <th className="r">V drop</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id}>
              <td>{r.circuit}</td>
              <td>{r.from}</td>
              <td>{r.to}</td>
              <td>
                <i className={`lw ${r.kind}`} /> {r.color}
              </td>
              <td className="mono">{r.gauge}</td>
              <td className="r">{r.lengthFt} ft</td>
              <td className="r">{r.amps !== undefined ? `${r.amps.toFixed(1)} A` : ''}</td>
              <td>{r.protection}</td>
              <td className={`r ${r.vdrop !== undefined && r.vdropLimit !== undefined && r.vdrop > r.vdropLimit ? 'bad' : ''}`}>
                {r.vdrop !== undefined ? `${r.vdrop.toFixed(1)}%` : ''}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Bom() {
  const design = useReportDesign();
  const rows = useMemo(() => billOfMaterials(design), [design]);
  const csv = () => downloadText('bill-of-materials.csv', toCsv([['Category', 'Item', 'Specification', 'Qty', 'Unit'], ...rows.map((r) => [r.category, r.item, r.spec, r.qty, r.unit])]));
  let lastCat = '';
  return (
    <div>
      <div className="report-actions">
        <span className="hint">Cable quantities include 10% for routing and waste. Parts are specifications, not brand recommendations.</span>
        <button onClick={csv}>Download CSV</button>
      </div>
      <table className="grid">
        <thead>
          <tr>
            <th>Item</th>
            <th>Specification</th>
            <th className="r">Qty</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => {
            const head = r.category !== lastCat;
            lastCat = r.category;
            return [
              head && (
                <tr key={`h${i}`} className="cat">
                  <td colSpan={3}>{r.category}</td>
                </tr>
              ),
              <tr key={i}>
                <td>{r.item}</td>
                <td>{r.spec}</td>
                <td className="r">
                  {r.qty} {r.unit === 'ea' ? '' : r.unit}
                </td>
              </tr>,
            ];
          })}
        </tbody>
      </table>
    </div>
  );
}

function Energy() {
  const project = useStore((s) => s.project);
  const b = energyBudget(project, activeScenario(project));
  const rows = [...b.rows].sort((x, y) => y.ahPerDay - x.ahPerDay);
  const max = Math.max(1, ...rows.map((r) => r.ahPerDay));
  return (
    <div className="energy">
      <div className="tiles">
        <div className="tile">
          <div className="tv">{Math.round(b.totalAhPerDay)} Ah</div>
          <div className="tl">used per day at {b.volts} V ({Math.round(b.totalWhPerDay)} Wh)</div>
        </div>
        <div className="tile">
          <div className="tv">{Math.round(b.houseAh)} Ah</div>
          <div className="tl">house bank · {Math.round(b.usableAh)} Ah usable</div>
        </div>
        <div className={`tile ${b.houseAh < b.recommendedAh * 0.9 ? 'warn' : 'ok'}`}>
          <div className="tv">{b.recommendedAh} Ah</div>
          <div className="tl">recommended for {b.daysAutonomy} days</div>
        </div>
        <div className="tile">
          <div className="tv">{Math.round(b.solarAhPerDay + b.windHydroAhPerDay)} Ah</div>
          <div className="tl">renewable charging / day (est.)</div>
        </div>
        <div className="tile">
          <div className="tv">{isFinite(b.engineHoursToBalance) ? `${b.engineHoursToBalance.toFixed(1)} h` : '—'}</div>
          <div className="tl">engine run per day to break even</div>
        </div>
      </div>
      <table className="grid">
        <thead>
          <tr>
            <th>Load</th>
            <th className="r">Power</th>
            <th className="r">Current</th>
            <th className="r">Hours/day</th>
            <th className="r">Duty</th>
            <th className="r">Ah/day</th>
            <th style={{ width: '30%' }} />
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id}>
              <td>{r.name}</td>
              <td className="r">{Math.round(r.watts)} W</td>
              <td className="r">{r.amps.toFixed(1)} A</td>
              <td className="r">{r.hoursPerDay}</td>
              <td className="r">{Math.round(r.dutyCycle)}%</td>
              <td className="r">{r.ahPerDay.toFixed(1)}</td>
              <td>
                <div className="bar" style={{ width: `${(r.ahPerDay / max) * 100}%` }} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="hint">
        Assumptions: solar {`4.5`} peak sun hours at 75% of rating; wind/hydro at 20% capacity factor; inverter 88% efficient. Edit hours per day and duty cycle on each load in the
        Equipment list.
      </p>
    </div>
  );
}

function Changes() {
  const project = useStore((s) => s.project);
  const setView = useStore((s) => s.setView);
  const ideal = useIdeal();
  const existing = useExisting();
  const changes = useMemo(() => (existing ? changeList(existing, ideal, acVoltsOf(project)) : []), [existing, ideal, project]);
  if (!existing)
    return (
      <div className="empty">
        <h3>No existing system yet</h3>
        <p>Draw your boat's current wiring in the Existing boat tab. The upgrade plan then lists what to change to reach the ideal design.</p>
        <button className="primary" onClick={() => setView('existing')}>
          Go to Existing boat
        </button>
      </div>
    );
  const groups: { id: 'safety' | 'recommended' | 'improvement'; title: string }[] = [
    { id: 'safety', title: 'Safety — fix first' },
    { id: 'recommended', title: 'Recommended' },
    { id: 'improvement', title: 'Improvements to reach the ideal design' },
  ];
  return (
    <div className="changes">
      <p className="hint">Existing drawing compared against the ideal design for scenario “{activeScenario(project)?.name}”.</p>
      {groups.map((g) => {
        const items = changes.filter((c) => c.priority === g.id);
        if (!items.length) return null;
        return (
          <section key={g.id} className={`chg-${g.id}`}>
            <h3>
              {g.title} <span className="count">{items.length}</span>
            </h3>
            <ol>
              {items.map((c, i) => (
                <li key={i}>
                  <div className="chg-title">{c.title}</div>
                  {c.detail && <div className="chg-detail">{c.detail}</div>}
                  {c.rule && !c.detail?.includes(ruleInfo(c.rule).why) && <div className="chg-rule">{ruleInfo(c.rule).title}</div>}
                </li>
              ))}
            </ol>
          </section>
        );
      })}
      {changes.length === 0 && <p>Your existing system already matches the ideal design.</p>}
    </div>
  );
}

/** One printable document for a reviewer: every report for the chosen design, plus the diagram and the standards notice. */
function FullReport() {
  const project = useStore((s) => s.project);
  const which = useStore((s) => s.reportDesign);
  const ideal = useIdeal();
  const existing = useExisting();
  const isExisting = which === 'existing' && !!existing;
  const design = isExisting ? existing : ideal;
  const findings = useFindings(design);
  const counts = findingCounts(findings);
  const scen = activeScenario(project);
  const [shot, setShot] = useState<{ id: Design; url: string } | null>(null);
  const picture = shot?.id === design ? shot.url : undefined;
  const p = project.profile;
  const today = new Date().toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });
  return (
    <div className="full-report">
      <header className="fr-head">
        <h1>{p.name || 'Untitled boat'} — electrical system report</h1>
        <div className="fr-meta">
          <span>{isExisting ? 'Existing wiring (as drawn)' : `Ideal design · scenario “${scen?.name ?? 'base'}”`}</span>
          <span>{design.systemVoltage} V DC</span>
          <span>Prepared {today}</span>
          <span>
            BoatWire v{__APP_VERSION__} ({__APP_COMMIT__})
          </span>
        </div>
        <p className="fr-summary">
          Design check: <b>{counts.errors}</b> error{counts.errors === 1 ? '' : 's'}, <b>{counts.warnings}</b> warning{counts.warnings === 1 ? '' : 's'}, <b>{counts.notes}</b> note{counts.notes === 1 ? '' : 's'}.
        </p>
        <p className="fr-notice">
          <b>For review by a qualified marine electrician.</b> {STANDARDS_NOTICE} Cable lengths are one-way estimates from zone distances, not measured runs.
        </p>
      </header>

      <section className="fr-section fr-diagram">
        <h2>Wiring diagram</h2>
        {picture ? <img src={picture} alt="Wiring diagram" /> : <p className="hint">Drawing the diagram…</p>}
        {/* Laid out off-screen, then turned into a picture that scales to the printed page. */}
        <div className="fr-diagram-render" aria-hidden>
          <Diagram key={isExisting ? 'existing' : 'ideal'} design={design} findings={findings} mode={isExisting ? 'manual' : 'auto'} readOnly onSnapshot={(url) => setShot({ id: design, url })} />
        </div>
      </section>

      <section className="fr-section">
        <h2>Design check</h2>
        <FindingsList findings={findings} design={isExisting ? 'existing' : 'ideal'} expanded />
      </section>

      {existing && (
        <section className="fr-section">
          <h2>Upgrade plan (existing → ideal)</h2>
          <Changes />
        </section>
      )}

      <section className="fr-section">
        <h2>Wire schedule</h2>
        <WireTable />
      </section>

      <section className="fr-section">
        <h2>Bill of materials</h2>
        <Bom />
      </section>

      <section className="fr-section">
        <h2>Energy budget</h2>
        <Energy />
      </section>
    </div>
  );
}
