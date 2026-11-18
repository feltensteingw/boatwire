import { HelpLink } from './Help';
import { useMemo } from 'react';
import { generateIdeal } from '../engine/generate';
import { designMetrics, type Metrics } from '../engine/reports';
import { lenUnit, toLen, toWeight, weightUnit } from '../model/units';
import type { Chemistry, Scenario, SystemVoltage } from '../model/types';
import { acVoltsOf } from '../state/derived';
import { useStore } from '../state/store';
import { NumInput, Select, TextInput } from './fields';

const CHEM: { value: Chemistry | ''; label: string }[] = [
  { value: '', label: 'As specified' },
  { value: 'flooded', label: 'Flooded' },
  { value: 'agm', label: 'AGM' },
  { value: 'gel', label: 'Gel' },
  { value: 'lifepo4', label: 'LiFePO4' },
];

export function Compare() {
  const project = useStore((s) => s.project);
  const updateScenario = useStore((s) => s.updateScenario);
  const removeScenario = useStore((s) => s.removeScenario);
  const addScenario = useStore((s) => s.addScenario);
  const setScenario = useStore((s) => s.setScenario);
  const setView = useStore((s) => s.setView);
  const acV = acVoltsOf(project);
  const units = project.profile.units;
  const metrics = useMemo(
    () =>
      project.scenarios.map((s) => {
        const d = generateIdeal(project, s);
        return { s, d, m: designMetrics(d, acV, units) };
      }),
    [project, acV, units],
  );
  const allRoles = new Set(metrics.flatMap((x) => [...x.m.roles]));
  const differing = [...allRoles].filter((r) => !metrics.every((x) => x.m.roles.has(r))).sort();
  const row = (label: string, f: (m: Metrics) => string | number, best?: 'min' | 'max') => {
    const vals = metrics.map((x) => f(x.m));
    const nums = vals.map((v) => (typeof v === 'number' ? v : NaN));
    const target = best === 'min' ? Math.min(...nums) : best === 'max' ? Math.max(...nums) : NaN;
    return (
      <tr>
        <th>{label}</th>
        {vals.map((v, i) => (
          <td key={i} className={!isNaN(target) && nums[i] === target && metrics.length > 1 ? 'best' : ''}>
            {v}
          </td>
        ))}
      </tr>
    );
  };
  return (
    <div className="compare">
      <div className="compare-head">
        <div>
          <h2>Compare scenarios</h2>
          <p className="hint">Each scenario regenerates the ideal design from the same equipment list with a different system voltage, battery chemistry or capacity. <HelpLink topic="compare" /></p>
        </div>
        <button className="primary" onClick={addScenario} data-tip="Add a what-if scenario to compare.">
          + New scenario
        </button>
      </div>
      <div className="compare-scroll">
        <table className="grid cmp">
          <thead>
            <tr>
              <th />
              {metrics.map(({ s }) => (
                <th key={s.id} className={s.id === project.activeScenario ? 'active' : ''}>
                  <ScenarioEditor
                    s={s}
                    onChange={(patch) => updateScenario(s.id, patch)}
                    onRemove={project.scenarios.length > 1 ? () => removeScenario(s.id) : undefined}
                  />
                  <button
                    className="link"
                    onClick={() => {
                      setScenario(s.id);
                      setView('ideal');
                    }}
                  >
                    View diagram →
                  </button>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {row('System voltage', (m) => `${m.volts} V`)}
            {row('House bank', (m) => m.houseBank)}
            {row('Main fuse', (m) => m.mainFuse)}
            {row('Main battery cable', (m) => m.mainCable)}
            {row('Largest cable', (m) => m.largestCable)}
            {row(`Copper (${weightUnit(units)}, est.)`, (m) => toWeight(m.copperLb, units), 'min')}
            {row(`Cable length (${lenUnit(units)})`, (m) => Math.round(toLen(m.cableFt, units)), 'min')}
            {row('Components', (m) => m.components, 'min')}
            {row('Errors', (m) => m.errors, 'min')}
            {row('Warnings', (m) => m.warnings, 'min')}
            {differing.length > 0 && (
              <tr className="cat">
                <td colSpan={metrics.length + 1}>Components that differ</td>
              </tr>
            )}
            {differing.map((r) => (
              <tr key={r}>
                <th>{r}</th>
                {metrics.map((x) => (
                  <td key={x.s.id}>{x.m.roles.has(r) ? '✓' : '—'}</td>
                ))}
              </tr>
            ))}
            <tr className="cat">
              <td colSpan={metrics.length + 1}>Design notes</td>
            </tr>
            <tr>
              <th />
              {metrics.map((x) => (
                <td key={x.s.id} className="notes">
                  {x.d.findings.length === 0 ? <span className="hint">—</span> : x.d.findings.map((f) => <div key={f.id} className={`note ${f.severity}`}>{f.message}</div>)}
                </td>
              ))}
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  );
}

function ScenarioEditor({ s, onChange, onRemove }: { s: Scenario; onChange: (p: Partial<Scenario>) => void; onRemove?: () => void }) {
  return (
    <div className="scen-edit">
      <TextInput label="Scenario name" value={s.name} onChange={(v) => onChange({ name: v })} />
      <span data-tip="System voltage for this scenario. “Boat voltage” uses the one set on the Boat & zones tab.">
      <Select<string>
        label={`${s.name}: system voltage`}
        value={String(s.systemVoltage ?? '')}
        options={[
          { value: '', label: 'Boat voltage' },
          { value: '12', label: '12 V' },
          { value: '24', label: '24 V' },
        ]}
        onChange={(v) => onChange({ systemVoltage: v ? (Number(v) as SystemVoltage) : undefined })}
      />
      </span>
      <span data-tip="House battery chemistry for this scenario. “As specified” uses your equipment list.">
        <Select<string> label={`${s.name}: house battery chemistry`} value={s.houseChemistry ?? ''} options={CHEM} onChange={(v) => onChange({ houseChemistry: (v || undefined) as Chemistry | undefined })} />
      </span>
      <span data-tip="House bank capacity in amp-hours at this scenario's system voltage (a 24 V 200 Ah bank stores the same energy as 12 V 400 Ah). Leave empty to keep your equipment list's size.">
        <NumInput label={`${s.name}: house bank capacity, amp-hours`} value={s.houseCapacityAh} unit="Ah @ sys V" onChange={(v) => onChange({ houseCapacityAh: v > 0 ? v : undefined })} />
      </span>
      {onRemove && (
        <button className="link danger" onClick={onRemove}>
          Remove
        </button>
      )}
    </div>
  );
}
