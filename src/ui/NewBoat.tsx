// "New boat": pick a starting point or answer a few questions, and get a first diagram.

import { useMemo, useState } from 'react';
import { create } from 'zustand';
import { energyBudget } from '../engine/energy';
import { CATALOG_BY_KIND } from '../model/catalog';
import { AC_STANDARDS } from '../model/standards';
import { buildBoat, CUSTOM_ANSWERS, LOAD_GROUPS, TEMPLATES, type BoatAnswers } from '../model/templates';
import type { Chemistry, EquipmentKind, SystemVoltage } from '../model/types';
import { useStore } from '../state/store';
import { Field, NumInput, Select, TextInput, Toggle } from './fields';
import { Modal } from './Modal';

/** Open the wizard from anywhere. `then` runs after the boat has been created (e.g. save it to the account). */
export const useNewBoat = create<{ open: boolean; then?: () => void; start(then?: () => void): void; close(): void }>((set) => ({
  open: false,
  start: (then) => set({ open: true, then }),
  close: () => set({ open: false, then: undefined }),
}));

const CHEMISTRY: { value: Chemistry; label: string }[] = [
  { value: 'agm', label: 'AGM (sealed lead-acid)' },
  { value: 'flooded', label: 'Flooded lead-acid' },
  { value: 'gel', label: 'Gel' },
  { value: 'lifepo4', label: 'Lithium (LiFePO4)' },
];
const STEPS = ['Start', 'The boat', 'Power', 'Appliances'] as const;

/** Mount once. Renders the wizard while it is open. */
export function NewBoatWizard() {
  const { open, then, close } = useNewBoat();
  if (!open) return null;
  return <Wizard close={close} then={then} />;
}

function Wizard({ close, then }: { close: () => void; then?: () => void }) {
  const loadProject = useStore((s) => s.loadProject);
  const newProject = useStore((s) => s.newProject);
  const setView = useStore((s) => s.setView);
  const [step, setStep] = useState(0);
  const [a, setA] = useState<BoatAnswers>(CUSTOM_ANSWERS);
  const set = (patch: Partial<BoatAnswers>) => setA((x) => ({ ...x, ...patch }));

  // What these answers add up to, so the battery question can be answered with the appliances in view.
  const budget = useMemo(() => energyBudget(buildBoat(a)), [a]);

  const create = (answers: BoatAnswers) => {
    loadProject(buildBoat(answers));
    setView('ideal');
    close();
    then?.();
  };
  const shoreOptions = [{ value: 0, label: 'None' }, ...AC_STANDARDS[a.acStandard].shoreOptions.map((n) => ({ value: n as number, label: `${n} A` }))];
  const toggleLoad = (kind: EquipmentKind, on: boolean) => set({ loads: on ? [...a.loads, kind] : a.loads.filter((k) => k !== kind) });

  return (
    <Modal label="New boat" className="wizard" onClose={close}>
      <div className="modal-head">
        <h3>New boat</h3>
        <button className="icon" onClick={close} aria-label="Close">
          ×
        </button>
      </div>
      <ol className="wiz-steps" aria-label="Steps">
        {STEPS.map((s, i) => (
          <li key={s} className={i === step ? 'on' : i < step ? 'done' : ''} aria-current={i === step ? 'step' : undefined}>
            {s}
          </li>
        ))}
      </ol>

      {step === 0 && (
        <div className="wiz-body">
          <p>Pick the boat closest to yours. You get a complete first diagram straight away and can change anything afterwards.</p>
          <div className="wiz-cards">
            {TEMPLATES.map((t) => (
              <div key={t.id} className="wiz-card">
                <b>{t.name}</b>
                <span>{t.blurb}</span>
                <div className="wiz-card-actions">
                  <button className="primary" onClick={() => create(t.answers)}>
                    Use this
                  </button>
                  <button
                    onClick={() => {
                      setA(t.answers);
                      setStep(1);
                    }}
                    data-tip="Start from this boat, then go through the questions to adjust it."
                  >
                    Adjust first
                  </button>
                </div>
              </div>
            ))}
          </div>
          <div className="wiz-alt">
            <button
              onClick={() => {
                setA(CUSTOM_ANSWERS);
                setStep(1);
              }}
            >
              Answer a few questions instead
            </button>
            <button
              className="link"
              onClick={() => {
                newProject();
                close();
                then?.();
              }}
              data-tip="Start with one house battery and nothing else, and add everything yourself."
            >
              Start with an empty boat
            </button>
          </div>
        </div>
      )}

      {step === 1 && (
        <div className="wiz-body wiz-form">
          <Field label="Boat name" help="Shown on the diagram, reports and file names.">
            <TextInput value={a.name} onChange={(name) => set({ name })} />
          </Field>
          <Field label="Length overall" help="Sets how far apart things are, and so how long the cables are. You can fine-tune each location later under Boat & zones.">
            <NumInput value={a.lengthFt} unit="ft" min={10} onChange={(lengthFt) => set({ lengthFt })} />
          </Field>
          <Field label="Battery system voltage" help="Most boats under about 45 ft are 12 V. 24 V halves the current, so cables are much smaller: worth it with a big inverter, windlass or thruster.">
            <Select<SystemVoltage>
              value={a.systemVoltage}
              options={[
                { value: 12, label: '12 V' },
                { value: 24, label: '24 V' },
              ]}
              onChange={(systemVoltage) => set({ systemVoltage })}
            />
          </Field>
          <Field label="Mains (AC) standard" help="120 V / 60 Hz in North America; 230 V / 50 Hz in Europe and most other places.">
            <Select
              value={a.acStandard}
              options={Object.entries(AC_STANDARDS).map(([k, v]) => ({ value: k as BoatAnswers['acStandard'], label: v.label }))}
              onChange={(acStandard) => set({ acStandard, shoreAmps: a.shoreAmps ? AC_STANDARDS[acStandard].shoreOptions[0] : 0 })}
            />
          </Field>
        </div>
      )}

      {step === 2 && (
        <div className="wiz-body wiz-form">
          <Field label="House battery type" help="Lithium costs more but gives about 80% of its capacity and charges fast. Lead-acid types give about 50%.">
            <Select value={a.houseChemistry} options={CHEMISTRY} onChange={(houseChemistry) => set({ houseChemistry })} />
          </Field>
          <Field label="House bank capacity" help="Total amp-hours at the battery system voltage. If you are not sure, leave it: the last step shows what your appliances need.">
            <NumInput value={a.houseAh} unit="Ah" min={50} step={50} onChange={(houseAh) => set({ houseAh })} />
          </Field>
          <Toggle checked={a.engine} label="Inboard engine with an alternator" tip="Leave off for an outboard or no engine." onChange={(engine) => set({ engine })} />
          {a.engine && (
            <>
              <Field label="Alternator output" help="Amps, from the engine manual or the alternator's label. 60 to 120 A is typical.">
                <NumInput value={a.alternatorAmps} unit="A" min={0} step={10} onChange={(alternatorAmps) => set({ alternatorAmps })} />
              </Field>
              <Toggle checked={a.startBattery} label="Separate engine start battery" tip="Recommended: a flat house bank can then never stop you starting the engine." onChange={(startBattery) => set({ startBattery })} />
            </>
          )}
          <Field label="Solar" help="Total rated watts of all panels. 0 for none.">
            <NumInput value={a.solarWatts} unit="W" min={0} step={50} onChange={(solarWatts) => set({ solarWatts })} />
          </Field>
          <Field label="Shore power" help="The rating of the inlet where you plug in at the dock.">
            <Select<number> value={a.shoreAmps} options={shoreOptions} onChange={(shoreAmps) => set({ shoreAmps })} />
          </Field>
          <Field label="Inverter" help="Makes mains power from the batteries. An inverter/charger also charges them from shore power.">
            <Select
              value={a.inverter}
              options={[
                { value: 'none', label: 'None' },
                { value: 'inverter', label: 'Inverter' },
                { value: 'inverter-charger', label: 'Inverter/charger' },
              ]}
              onChange={(inverter) => set({ inverter, inverterWatts: inverter === 'none' ? 0 : a.inverterWatts || 2000 })}
            />
          </Field>
          {a.inverter !== 'none' && (
            <Field label="Inverter size" help="Continuous watts. 2000 W runs a microwave or kettle; 3000 W and up for induction cooking or air conditioning.">
              <NumInput value={a.inverterWatts} unit="W" min={300} step={500} onChange={(inverterWatts) => set({ inverterWatts })} />
            </Field>
          )}
        </div>
      )}

      {step === 3 && (
        <div className="wiz-body">
          <p>Tick what is aboard. Each one is added with typical values, which you can change later.</p>
          <div className="wiz-loads">
            {LOAD_GROUPS.map((g) => (
              <fieldset key={g.title}>
                <legend>{g.title}</legend>
                {g.kinds.map((k) => (
                  <Toggle key={k} checked={a.loads.includes(k)} label={CATALOG_BY_KIND[k].label} onChange={(on) => toggleLoad(k, on)} />
                ))}
              </fieldset>
            ))}
          </div>
        </div>
      )}

      {step > 0 && (
        <>
          <p className={`wiz-budget ${budget.houseAh < budget.recommendedAh * 0.9 ? 'warn' : ''}`} role="status">
            These choices use about <b>{Math.round(budget.totalAhPerDay)} Ah a day</b>. For two days without charging that suggests a house bank of about <b>{budget.recommendedAh} Ah</b>; you have chosen <b>{Math.round(budget.houseAh)} Ah</b>.
          </p>
          <div className="modal-foot wiz-foot">
            <button onClick={() => setStep(step - 1)}>Back</button>
            {step < STEPS.length - 1 ? (
              <button className="primary" onClick={() => setStep(step + 1)}>
                Next
              </button>
            ) : (
              <button className="primary" onClick={() => create(a)}>
                Create my boat
              </button>
            )}
          </div>
        </>
      )}
    </Modal>
  );
}
