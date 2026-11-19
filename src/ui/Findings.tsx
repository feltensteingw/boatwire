import { ruleInfo } from '../engine/rules';
import type { Finding } from '../model/types';
import { useStore } from '../state/store';

export function FindingItem({ f, design, expanded }: { f: Finding; design?: 'ideal' | 'existing'; expanded?: boolean }) {
  const select = useStore((s) => s.select);
  const view = useStore((s) => s.view);
  const setView = useStore((s) => s.setView);
  const units = useStore((s) => s.project.profile.units);
  const which = design ?? (view === 'existing' ? 'existing' : 'ideal');
  const target = f.nodes?.[0] ? { kind: 'node' as const, id: f.nodes[0] } : f.wires?.[0] ? { kind: 'wire' as const, id: f.wires[0] } : undefined;
  const r = ruleInfo(f.rule, units);
  return (
    <div className={`finding f-${f.severity}`}>
      <div className="f-head">
        <span className={`sev ${f.severity}`}>{f.severity}</span>
        <span className="f-msg">{f.message}</span>
      </div>
      {f.fix && <div className="f-fix">→ {f.fix}</div>}
      <div className="f-foot">
        <details open={expanded}>
          <summary>{r.title}</summary>
          <p>{r.why}</p>
          {r.ref && <p className="ref">{r.ref}</p>}
        </details>
        {target && !expanded && (
          <button
            className="link"
            onClick={() => {
              if (view !== which) setView(which);
              setTimeout(() => select({ ...target, design: which }), 0);
            }}
          >
            Show
          </button>
        )}
      </div>
    </div>
  );
}

/** expanded: show every rule explanation and no navigation buttons (printed report). */
export function FindingsList({ findings, design, expanded }: { findings: Finding[]; design: 'ideal' | 'existing'; expanded?: boolean }) {
  const order = { error: 0, warning: 1, info: 2 };
  const sorted = [...findings].sort((a, b) => order[a.severity] - order[b.severity]);
  if (!sorted.length) return <p className="hint">No problems found.</p>;
  return (
    <div className="findings">
      {sorted.map((f) => (
        <FindingItem key={f.id} f={f} design={design} expanded={expanded} />
      ))}
    </div>
  );
}
