import { useEffect, useState, type ReactNode } from 'react';
import type { PropDef } from '../model/catalog';
import type { PropValue } from '../model/types';

export function Field({ label, children, help }: { label: string; children: ReactNode; help?: string }) {
  return (
    <label className="field" title={help}>
      <span className="field-label">
        {label}
        {help && <span className="help-dot">?</span>}
      </span>
      {children}
    </label>
  );
}

export function NumInput({ value, onChange, unit, min, step }: { value: number | undefined; onChange: (v: number) => void; unit?: string; min?: number; step?: number }) {
  const [text, setText] = useState(value === undefined ? '' : String(value));
  useEffect(() => setText(value === undefined ? '' : String(value)), [value]);
  return (
    <span className="num">
      <input
        type="number"
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

export function TextInput({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder?: string }) {
  return <input type="text" value={value} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} />;
}

export function Select<T extends string | number>({ value, options, onChange }: { value: T | undefined; options: { value: T; label: string }[]; onChange: (v: T) => void }) {
  return (
    <select
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

export function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <label className="toggle">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span>{label}</span>
    </label>
  );
}

export function PropEditor({ def, value, onChange }: { def: PropDef; value: PropValue | undefined; onChange: (v: PropValue) => void }) {
  if (def.type === 'bool') return <Toggle checked={!!value} onChange={onChange} label={def.label} />;
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
