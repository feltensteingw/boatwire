import { useState } from 'react';
import { CATALOG, CATALOG_BY_KIND, CATEGORY_LABELS, type Category } from '../model/catalog';
import { AC_STANDARDS, STANDARDS_VERIFIED } from '../model/standards';
import type { Equipment, EquipmentKind, SystemVoltage } from '../model/types';
import { energyBudget } from '../engine/energy';
import { activeScenario } from '../engine/scenario';
import { uid } from '../model/examples';
import { useStore } from '../state/store';
import { Field, NumInput, PropEditor, Select, TextInput } from './fields';

const ORDER: Category[] = ['storage', 'engine', 'charging', 'ac-source', 'dc-load', 'ac-load'];

export function Sidebar() {
  const [tab, setTab] = useState<'equipment' | 'boat'>('equipment');
  return (
    <aside className="sidebar">
      <div className="seg">
        <button className={tab === 'equipment' ? 'on' : ''} onClick={() => setTab('equipment')} data-tip="Everything aboard that uses or makes power. The ideal design is generated from this list.">
          Equipment
        </button>
        <button className={tab === 'boat' ? 'on' : ''} onClick={() => setTab('boat')} data-tip="Boat name, system voltage, AC standard, and where things are aboard (used to work out cable lengths).">
          Boat &amp; zones
        </button>
      </div>
      {tab === 'equipment' ? <EquipmentList /> : <BoatPanel />}
    </aside>
  );
}

function EquipmentList() {
  const project = useStore((s) => s.project);
  const addEquipment = useStore((s) => s.addEquipment);
  const [open, setOpen] = useState<string | null>(null);
  const budget = energyBudget(project, activeScenario(project));
  return (
    <div className="eq">
      <div className="eq-add">
        <select
          value=""
          data-tip="Add batteries, the engine, chargers, solar, AC sources, or any DC / AC appliance. Typical values are filled in; click the item to adjust them."
          onChange={(e) => {
            if (!e.target.value) return;
            const id = addEquipment(e.target.value as EquipmentKind);
            setOpen(id);
          }}
        >
          <option value="">+ Add equipment…</option>
          {ORDER.map((cat) => (
            <optgroup key={cat} label={CATEGORY_LABELS[cat]}>
              {CATALOG.filter((c) => c.category === cat).map((c) => (
                <option key={c.kind} value={c.kind}>
                  {c.label}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
      </div>
      <div className="budget" data-tip={'Energy budget.\nAh/day used: what all loads consume in a typical day.\nUsable: the share of the house bank you can safely use (about 50% lead-acid, 80% lithium).\nRecommended: enough for about two days without charging.'}>
        <div>
          <b>{Math.round(budget.totalAhPerDay)}</b> Ah/day used
        </div>
        <div>
          <b>{Math.round(budget.houseAh)}</b> Ah house ({Math.round(budget.usableAh)} usable)
        </div>
        <div className={budget.houseAh < budget.recommendedAh * 0.9 ? 'warn' : 'ok'}>
          ~{budget.recommendedAh} Ah recommended
        </div>
      </div>
      {ORDER.map((cat) => {
        const items = project.equipment.filter((e) => CATALOG_BY_KIND[e.kind]?.category === cat);
        if (!items.length) return null;
        return (
          <section key={cat}>
            <h4>{CATEGORY_LABELS[cat]}</h4>
            {items.map((e) => (
              <EquipmentRow key={e.id} e={e} open={open === e.id} onToggle={() => setOpen(open === e.id ? null : e.id)} />
            ))}
          </section>
        );
      })}
    </div>
  );
}

function summary(e: Equipment): string {
  const p = e.props;
  switch (e.kind) {
    case 'battery-bank':
      return `${p.role} · ${p.units}× ${p.unitVolts} V ${p.unitAh} Ah ${String(p.chemistry).toUpperCase()}`;
    case 'engine':
      return `${p.alternatorAmps} A alt · ${p.regulator} reg.`;
    case 'shore-power':
      return `${p.amps} A`;
    case 'battery-charger':
      return `${p.amps} A`;
    case 'inverter-charger':
      return `${p.watts} W / ${p.chargeAmps} A`;
    default:
      return p.watts !== undefined ? `${p.watts} W${p.hoursPerDay !== undefined ? ` · ${p.hoursPerDay} h/d` : ''}` : '';
  }
}

export function EquipmentRow({ e, open, onToggle }: { e: Equipment; open: boolean; onToggle: () => void }) {
  const zones = useStore((s) => s.project.profile.zones);
  const update = useStore((s) => s.updateEquipment);
  const remove = useStore((s) => s.removeEquipment);
  const dup = useStore((s) => s.duplicateEquipment);
  const c = CATALOG_BY_KIND[e.kind];
  return (
    <div className={`eq-row ${open ? 'open' : ''}`}>
      <button className="eq-head" onClick={onToggle} data-tip={open ? 'Click to close' : 'Click to edit size, location and usage'}>
        <span className="eq-glyph">{c?.glyph}</span>
        <span className="eq-name">{e.name}</span>
        <span className="eq-sum">{summary(e)}</span>
      </button>
      {open && <EquipmentEditor e={e} zones={zones} update={update} remove={remove} dup={dup} />}
    </div>
  );
}

export function EquipmentEditor({
  e,
  zones,
  update,
  remove,
  dup,
}: {
  e: Equipment;
  zones: { id: string; name: string }[];
  update: (id: string, fn: (e: Equipment) => void) => void;
  remove?: (id: string) => void;
  dup?: (id: string) => void;
}) {
  const c = CATALOG_BY_KIND[e.kind];
  return (
    <div className="eq-edit">
      <Field label="Name" help="Shown on the diagram and in reports.">
        <TextInput value={e.name} onChange={(v) => update(e.id, (x) => void (x.name = v))} />
      </Field>
      <Field label="Location" help="Where it is aboard. Sets the cable length from the batteries or panel, and so the wire size.">
        <Select value={e.zone} options={zones.map((z) => ({ value: z.id, label: z.name }))} onChange={(v) => update(e.id, (x) => void (x.zone = v))} />
      </Field>
      {c?.defs
        .filter((d) => !(d.key === 'bms' && e.props.chemistry !== 'lifepo4'))
        .map((d) => (
          <PropEditor key={d.key} def={d} value={e.props[d.key]} onChange={(v) => update(e.id, (x) => void (x.props[d.key] = v))} />
        ))}
      {c?.help && <p className="hint">{c.help}</p>}
      {(remove || dup) && (
        <div className="row-actions">
          {dup && <button onClick={() => dup(e.id)}>Duplicate</button>}
          {remove && (
            <button className="danger" onClick={() => remove(e.id)}>
              Remove
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function BoatPanel() {
  const profile = useStore((s) => s.project.profile);
  const up = useStore((s) => s.updateProfile);
  const zoneOpts = profile.zones.map((z) => ({ value: z.id, label: z.name }));
  return (
    <div className="boat">
      <Field label="Boat name" help="Used on the diagram, reports and file names.">
        <TextInput value={profile.name} onChange={(v) => up((p) => void (p.name = v))} />
      </Field>
      <Field label="Length overall" help="Boat length, for reference.">
        <NumInput value={profile.lengthFt} unit="ft" onChange={(v) => up((p) => void (p.lengthFt = v))} />
      </Field>
      <Field label="DC system voltage" help="The battery system voltage. 24 V halves the current, so cables are much smaller, which helps with big inverters, windlasses and thrusters. 12 V-only gear then needs a converter. Scenarios can override this to compare.">
        <Select<SystemVoltage> value={profile.systemVoltage} options={[{ value: 12, label: '12 V' }, { value: 24, label: '24 V' }]} onChange={(v) => up((p) => void (p.systemVoltage = v))} />
      </Field>
      <Field label="AC standard" help="Mains power standard: 120 V / 60 Hz (North America) or 230 V / 50 Hz (Europe and most elsewhere). Sets AC cable sizes and breaker ratings.">
        <Select value={profile.acStandard} options={Object.entries(AC_STANDARDS).map(([k, v]) => ({ value: k as 'us120' | 'eu230', label: v.label }))} onChange={(v) => up((p) => void (p.acStandard = v))} />
      </Field>
      <Field label="Battery / main bus location" help="Where the batteries and main bus bars are. Every battery-fed cable length is measured from here.">
        <Select value={profile.batteryZone} options={zoneOpts} onChange={(v) => up((p) => void (p.batteryZone = v))} />
      </Field>
      <Field label="Main panel location" help="Where the main DC/AC distribution panel is. Branch circuit lengths are measured from here.">
        <Select value={profile.panelZone} options={zoneOpts} onChange={(v) => up((p) => void (p.panelZone = v))} />
      </Field>
      <h4>Zones</h4>
      <p className="hint">Cable lengths are estimated from where things are: distance aft of the bow, plus extra height or routing (the masthead is ~50 ft up). Runs add 20% for routing along the hull.</p>
      <table className="zones">
        <thead>
          <tr>
            <th>Zone</th>
            <th data-tip="Distance aft of the bow, in feet.">Aft (ft)</th>
            <th data-tip="Extra vertical or routing distance, in feet (e.g. ~50 ft up to a masthead).">Rise (ft)</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {profile.zones.map((z, i) => (
            <tr key={z.id}>
              <td>
                <input value={z.name} onChange={(e) => up((p) => void (p.zones[i].name = e.target.value))} />
              </td>
              <td>
                <input type="number" value={z.x} onChange={(e) => up((p) => void (p.zones[i].x = +e.target.value))} />
              </td>
              <td>
                <input type="number" value={z.rise} onChange={(e) => up((p) => void (p.zones[i].rise = +e.target.value))} />
              </td>
              <td>
                <button className="icon" data-tip="Remove zone" onClick={() => up((p) => void p.zones.splice(i, 1))}>
                  ×
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <button data-tip="Add a location aboard, e.g. a radar arch or fly bridge." onClick={() => up((p) => void p.zones.push({ id: uid('z'), name: 'New zone', x: 10, rise: 1 }))}>+ Add zone</button>
      {!STANDARDS_VERIFIED && (
        <p className="hint caution">
          Wire tables and limits are seeded from widely published ABYC-derived values and have not been checked against the current ABYC E-11 text. Have a qualified marine electrician review any design before installation.
        </p>
      )}
    </div>
  );
}
