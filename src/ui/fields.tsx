import { useEffect, useState, type ReactNode } from 'react';
import type { PropDef } from '../model/catalog';
import type { PropValue } from '../model/types';

export function Field({ label, children, help }: { label: string; children: ReactNode; help?: string }) {
  return (
    <label className="field" data-tip={help}>
      <span className="field-label">
        {label}
        {help && <span className="help-dot">?</span>}
      </span>
      {children}
    </label>
  );
}

/** `label` names the control for screen readers when it has no visible label of its own (e.g. in a table cell). */
export function NumInput({ value, onChange, unit, min, step, label }: { value: number | undefined; onChange: (v: number) => void; unit?: string; min?: number; step?: number; label?: string }) {
  const [text, setText] = useState(value === undefined ? '' : String(value));
  useEffect(() => setText(value === undefined ? '' : String(value)), [value]);
  return (
    <span className="num">
      <input
        type="number"
        aria-label={label}
        value={text}
        min={min}
        step={step ?? 'any'}
        onChange={(e) => {
          setText(e.target.value);
          if (e.target.value !== '' && !isNaN(+e.target.value)) onChange(+e.target.value);
        }}
      />
      {unit && <span className="unit">{unit}</span>}
    </span>
  );
}

export function TextInput({ value, onChange, placeholder, label }: { value: string; onChange: (v: string) => void; placeholder?: string; label?: string }) {
  return <input type="text" aria-label={label} value={value} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} />;
}

export function Select<T extends string | number>({ value, options, onChange, label }: { value: T | undefined; options: { value: T; label: string }[]; onChange: (v: T) => void; label?: string }) {
  return (
    <select
      aria-label={label}
      value={value === undefined ? '' : String(value)}
      onChange={(e) => {
        const o = options.find((x) => String(x.value) === e.target.value);
        if (o) onChange(o.value);
      }}
    >
      {value === undefined && <option value="">—</option>}
      {options.map((o) => (
        <option key={String(o.value)} value={String(o.value)}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

export function Toggle({ checked, onChange, label, tip }: { checked: boolean; onChange: (v: boolean) => void; label: string; tip?: string }) {
  return (
    <label className="toggle" data-tip={tip}>
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span>{label}</span>
    </label>
  );
}

export function PropEditor({ def, value, onChange }: { def: PropDef; value: PropValue | undefined; onChange: (v: PropValue) => void }) {
  if (def.type === 'bool') return <Toggle checked={!!value} onChange={onChange} label={def.label} tip={def.help} />;
  if (def.type === 'select')
    return (
      <Field label={def.label} help={def.help}>
        <Select value={value as string | number | undefined} options={def.options ?? []} onChange={onChange} />
      </Field>
    );
  return (
    <Field label={def.label} help={def.help}>
      <NumInput value={typeof value === 'number' ? value : undefined} onChange={onChange} unit={def.unit} min={def.min} step={def.step} />
    </Field>
  );
}
