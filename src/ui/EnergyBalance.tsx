import { useState } from 'react';
import { daysText, type EnergyBudget } from '../engine/energy';
import { ENERGY_ASSUMPTIONS, ENERGY_LIMITS, ENERGY_PRESETS } from '../model/standards';
import type { EnergyAssumptions, Scenario } from '../model/types';
import { useStore } from '../state/store';
import { Field, NumInput } from './fields';

const ah = (n: number) => `${Math.round(n)} Ah`;
const hours = (n: number) => `${n < 10 ? Math.round(n * 10) / 10 : Math.round(n)} h`;
const share = (part: number, whole: number) => (whole > 0 ? `${Math.round((part / whole) * 100)}%` : '—');
/** A charger or alternator that could give more than is needed: say so, since only what is needed is counted. */
const spare = (canGive: number, gives: number) => (canGive > gives + 1 ? ` (could give ${Math.round(canGive)} Ah; only what is needed is counted)` : '');
/** "90 A alternator", or on a twin-engine boat "2 alternators, 180 A together". */
const alternators = (b: EnergyBudget) => (b.alternators > 1 ? `${b.alternators} alternators, ${Math.round(b.alternatorAmps)} A together` : `${Math.round(b.alternatorAmps)} A alternator`);

/**
 * A typical day: what the boat uses against what each source puts back, on one scale, with the
 * figures listed beside it. The list is the readable twin of the bars: every value is in it.
 */
export function DailyBalance({ b }: { b: EnergyBudget }) {
  const a = b.assumptions;
  const sources = [
    { id: 's1', name: 'Solar', how: `${hours(a.solarPeakHours)} of full sun at ${Math.round(a.solarDerate * 100)}% of the panels' rating`, value: b.solarAhPerDay },
    { id: 's2', name: 'Wind and hydro', how: `${Math.round(a.windHydroCapacityFactor * 100)}% of rating, day and night`, value: b.windHydroAhPerDay },
    { id: 's3', name: 'Shore charger', how: b.chargerAmps > 0 ? `${Math.round(b.chargerAmps)} A charger, ${hours(a.shoreHoursPerDay)} a day plugged in${spare(b.shoreCanGiveAhPerDay, b.shoreAhPerDay)}` : 'no shore power and charger aboard', value: b.shoreAhPerDay },
    { id: 's4', name: 'Engine', how: b.alternatorAmps > 0 ? `${alternators(b)}, ${hours(a.engineHoursPerDay)} a day running anyway${spare(b.engineCanGiveAhPerDay, b.engineAhPerDay)}` : 'no alternator aboard', value: b.engineAhPerDay },
  ];
  const used = b.totalAhPerDay;
  const charging = b.chargingAhPerDay;
  const scale = Math.max(used, charging, 1);
  const width = (v: number) => `${(v / scale) * 100}%`;
  const short = b.shortfallAhPerDay;

  let verdict: string;
  if (used === 0) verdict = 'Nothing aboard draws from the batteries yet.';
  else if (short === 0) verdict = `Charging covers the day's use${b.surplusAhPerDay >= 1 ? `, with about ${ah(b.surplusAhPerDay)} of sun and wind to spare` : ''}.`;
  else {
    const lasts = b.usableAh > 0 ? ` Left alone, the usable part of the house bank (${ah(b.usableAh)}) would last about ${Math.max(0.1, Math.round((b.usableAh / short) * 10) / 10)} days.` : '';
    const engine = isFinite(b.extraEngineHours) ? ` Running ${b.alternators > 1 ? 'both engines' : 'the engine'} about ${hours(b.extraEngineHours)} ${a.engineHoursPerDay > 0 ? 'more ' : ''}a day would make it up.` : ' There is no alternator to make it up.';
    verdict = `Charging covers ${ah(charging)} of the ${ah(used)} used, leaving ${ah(short)} a day to find.${engine}${lasts}`;
  }

  return (
    <section className="balance" aria-labelledby="balance-title">
      <h3 id="balance-title">A typical day</h3>
      <div className="bal-rows" role="img" aria-label={`Used ${ah(used)} a day. Charging ${ah(charging)} a day: ${sources.map((s) => `${s.name} ${ah(s.value)}`).join(', ')}.`}>
        <div className="bal-row">
          <span className="bal-name">Used</span>
          <span className="bal-track">
            {used > 0 && <span className="bal-bar used" style={{ width: width(used) }} data-tip={`${ah(used)} used in a day by everything in the table below.`} />}
          </span>
          <span className="bal-val">{ah(used)}</span>
        </div>
        <div className="bal-row">
          <span className="bal-name">Charging</span>
          <span className="bal-track">
            {charging > 0 && (
              <span className="bal-stack" style={{ width: width(charging) }}>
                {sources
                  .filter((s) => s.value > 0)
                  .map((s) => (
                    <span key={s.id} className={`bal-seg ${s.id}`} style={{ flexGrow: s.value }} data-tip={`${s.name}: ${ah(s.value)} a day (${share(s.value, used)} of what is used).\n${s.how}.`} />
                  ))}
              </span>
            )}
          </span>
          <span className="bal-val">{ah(charging)}</span>
        </div>
      </div>
      <table className="bal-list">
        <thead>
          <tr>
            <th>Charging from</th>
            <th>Assuming</th>
            <th className="r">Ah a day</th>
            <th className="r">Share of use</th>
          </tr>
        </thead>
        <tbody>
          {sources.map((s) => (
            <tr key={s.id} className={s.value > 0 ? '' : 'none'}>
              <th scope="row">
                <span className={`bal-key ${s.id}`} aria-hidden="true" />
                {s.name}
              </th>
              <td>{s.how}</td>
              <td className="r">{Math.round(s.value)}</td>
              <td className="r">{share(s.value, used)}</td>
            </tr>
          ))}
        </tbody>
        {(short > 0 || b.surplusAhPerDay >= 1) && (
          <tfoot>
            <tr>
              <th scope="row" colSpan={2}>
                {short > 0 ? 'Shortfall' : 'Sun and wind to spare'}
              </th>
              <td className="r">{Math.round(short > 0 ? short : b.surplusAhPerDay)}</td>
              <td className="r">{share(short > 0 ? short : b.surplusAhPerDay, used)}</td>
            </tr>
          </tfoot>
        )}
      </table>
      <p className="bal-verdict">{verdict}</p>
    </section>
  );
}

type Key = keyof EnergyAssumptions;

const FIELDS: { key: Key; label: string; unit: string; percent?: boolean; step: number; help: string }[] = [
  { key: 'solarPeakHours', label: 'Peak sun hours a day', unit: 'h', step: 0.5, help: 'Hours a day of full-strength sun. About 5 to 6 in the tropics or a mid-latitude summer, 1 to 3 in winter. It depends on where you are and the season.' },
  { key: 'solarDerate', label: 'Solar output, share of rating', unit: '%', percent: true, step: 5, help: "How much of the panels' rated power actually arrives: heat, the angle of the sun, shading and the controller all take some. 75% is typical for flat-mounted panels." },
  { key: 'windHydroCapacityFactor', label: 'Wind and hydro, average output', unit: '%', percent: true, step: 5, help: 'Average output of a wind or hydro generator as a share of its rating, over the whole day.' },
  { key: 'daysAutonomy', label: 'Days of autonomy', unit: 'days', step: 0.5, help: 'How many days the house bank should carry the boat. The recommended bank size is this many days of use at a safe depth of discharge.' },
  { key: 'chargingDuringAutonomy', label: 'Solar and wind counted in those days', unit: '%', percent: true, step: 10, help: 'How much of the normal solar, wind and hydro charge you count on during the days of autonomy. 0% is the cautious rule: the bank must carry the boat with no charging at all. Raise it if you sail where the sun is dependable.' },
  { key: 'shoreHoursPerDay', label: 'Hours a day on shore power', unit: 'h', step: 1, help: 'Hours a day plugged in with the battery charger running. 0 at anchor, 24 in a marina.' },
  { key: 'engineHoursPerDay', label: 'Hours a day the engine runs anyway', unit: 'h', step: 0.5, help: 'Hours a day you expect to motor whatever the batteries need. The alternator charges for that long. With two engines, both are taken to run this long.' },
];

/** The conditions the energy budget assumes: presets and the values behind them, for the boat or for one scenario. */
export function EnergyAssumptionsPanel({ b, scenario, boatValues }: { b: EnergyBudget; scenario: Scenario | undefined; boatValues: Partial<EnergyAssumptions> | undefined }) {
  const setEnergy = useStore((s) => s.setEnergy);
  const resetEnergy = useStore((s) => s.resetEnergy);
  const scenarioCount = useStore((s) => s.project.scenarios.length);
  const own = !!scenario?.energy;
  const [onlyThis, setOnlyThis] = useState(false);
  const forScenario = !!scenario && (own || onlyThis);
  const target = forScenario ? scenario.id : undefined;
  const a = b.assumptions;
  const changed = (k: Key) => (forScenario ? scenario?.energy?.[k] !== undefined : boatValues?.[k] !== undefined);
  const anyChanged = forScenario ? own : !!boatValues;
  const matching = (presets: readonly { id: string; set: Partial<EnergyAssumptions> }[]) => presets.find((p) => Object.entries(p.set).every(([k, v]) => a[k as Key] === v))?.id ?? '';
  const preset = (group: 'sun' | 'use', label: string) => (
    <label className="preset">
      <span>{label}</span>
      <select
        aria-label={label}
        value={matching(ENERGY_PRESETS[group])}
        onChange={(e) => {
          const p = ENERGY_PRESETS[group].find((x) => x.id === e.target.value);
          if (p) setEnergy(p.set, target);
        }}
      >
        <option value="">Your own figures</option>
        {ENERGY_PRESETS[group].map((p) => (
          <option key={p.id} value={p.id}>
            {p.label}
          </option>
        ))}
      </select>
    </label>
  );

  return (
    <section className="assume" aria-labelledby="assume-title">
      <div className="assume-head">
        <h3 id="assume-title">Assumptions</h3>
        {scenario && scenarioCount > 1 && (
          <label className="toggle" data-tip="Tick this to give this scenario its own conditions, for example a winter scenario next to a summer one. Unticked, the figures apply to every scenario of this boat.">
            <input
              type="checkbox"
              checked={forScenario}
              onChange={(e) => {
                setOnlyThis(e.target.checked);
                if (!e.target.checked && own) resetEnergy(scenario.id);
              }}
            />
            <span>Different for the scenario “{scenario.name}”</span>
          </label>
        )}
        <button className="link" disabled={!anyChanged} onClick={() => resetEnergy(target)} data-tip={forScenario ? "Drop this scenario's own figures and use the boat's." : 'Put every figure back to its starting value. You can undo this.'}>
          {forScenario ? "Use the boat's figures" : 'Reset'}
        </button>
      </div>
      <p className="hint">
        The budget is only as good as these figures, and the starting ones are rough, typical values. Set them for where and how you sail. They are saved with the boat.
      </p>
      <div className="presets">
        {preset('sun', 'Where and when')}
        {preset('use', 'How the boat is used')}
      </div>
      <div className="assume-grid">
        {FIELDS.map((f) => {
          const [lo, hi] = ENERGY_LIMITS[f.key];
          const k = f.percent ? 100 : 1;
          return (
            <div key={f.key} className={changed(f.key) ? 'own' : ''}>
              <Field label={f.label} help={`${f.help}\nStarting value: ${ENERGY_ASSUMPTIONS[f.key] * k} ${f.unit}.`}>
                <NumInput
                  label={f.label}
                  value={Math.round(a[f.key] * k * 100) / 100}
                  unit={f.unit}
                  min={lo * k}
                  step={f.step}
                  onChange={(v) => setEnergy({ [f.key]: Math.min(hi, Math.max(lo, v / k)) }, target)}
                />
              </Field>
            </div>
          );
        })}
      </div>
      <p className="hint">
        Not adjustable here: the inverter is taken as {Math.round(a.inverterEfficiency * 100)}% efficient, and {Math.round(a.alternatorChargeEfficiency * 100)}% of the alternator's or charger's rated output is taken to reach the bank
        (lead-acid accepts charge more slowly as it fills; lithium takes nearly all of it). The recommended bank is {daysText(a.daysAutonomy)} of use
        {a.chargingDuringAutonomy > 0 ? `, less ${Math.round(a.chargingDuringAutonomy * 100)}% of the usual solar and wind charge,` : ''} at a safe depth of discharge.
      </p>
    </section>
  );
}
