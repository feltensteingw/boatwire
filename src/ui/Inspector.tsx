import { useMemo } from 'react';
import { estimateCurrents } from '../engine/audit';
import { ampacity, fmtGauge, gaugeSpec, vdropPct } from '../engine/calc';
import { ruleInfo } from '../engine/rules';
import { growTerminal, NODE_DEFS } from '../model/nodeDefs';
import { GAUGES, VDROP } from '../model/standards';
import type { Design, DNode, Finding, Wire } from '../model/types';
import { acVoltsOf } from '../state/derived';
import { useStore } from '../state/store';
import { EquipmentEditor } from './Sidebar';
import { Field, NumInput, Select, TextInput, Toggle } from './fields';
import { FindingItem } from './Findings';

export function Inspector({ design, findings, editable }: { design: Design; findings: Finding[]; editable: boolean }) {
  const selection = useStore((s) => s.selection);
  const node = selection?.kind === 'node' ? design.nodes.find((n) => n.id === selection.id) : undefined;
  const wire = selection?.kind === 'wire' ? design.wires.find((w) => w.id === selection.id) : undefined;
  return (
    <aside className="inspector">
      {node ? (
        <NodeInspector node={node} design={design} findings={findings} editable={editable} />
      ) : wire ? (
        <WireInspector wire={wire} design={design} findings={findings} editable={editable} />
      ) : (
        <Overview findings={findings} />
      )}
    </aside>
  );
}

function Overview({ findings }: { findings: Finding[] }) {
  const errors = findings.filter((f) => f.severity === 'error');
  const warnings = findings.filter((f) => f.severity === 'warning');
  const infos = findings.filter((f) => f.severity === 'info');
  return (
    <div>
      <h3>Design check</h3>
      <div className="counts">
        <span className="c-err">{errors.length} errors</span>
        <span className="c-warn">{warnings.length} warnings</span>
        <span className="c-info">{infos.length} notes</span>
      </div>
      {findings.length === 0 && <p className="hint">No problems found.</p>}
      <div className="findings compact">
        {[...errors, ...warnings, ...infos].slice(0, 12).map((f) => (
          <FindingItem key={f.id} f={f} />
        ))}
      </div>
      <Legend />
      <p className="hint">Click any component or wire to see its ratings and why it's there.</p>
    </div>
  );
}

function Legend() {
  return (
    <div className="legend">
      <h4>Legend</h4>
      <div>
        <i className="lw pos" /> DC positive (red)
      </div>
      <div>
        <i className="lw neg" /> DC negative (black/yellow)
      </div>
      <div>
        <i className="lw ac" /> AC circuit (one-line)
      </div>
      <div>
        <i className="lw gnd" /> AC grounding / bonding
      </div>
      <div>
        <i className="lw sig" /> Control / signal
      </div>
      <div className="hint">Thicker lines are heavier cables.</div>
    </div>
  );
}

function Why({ notes }: { notes?: string[] }) {
  if (!notes?.length) return null;
  const uniq = [...new Set(notes)];
  return (
    <div className="why">
      <h4>Why it's wired this way</h4>
      {uniq.map((id) => {
        const r = ruleInfo(id);
        return (
          <details key={id} open={uniq.length <= 2}>
            <summary>{r.title}</summary>
            <p>{r.why}</p>
            {r.ref && <p className="ref">{r.ref}</p>}
          </details>
        );
      })}
    </div>
  );
}

function NodeInspector({ node, design, findings, editable }: { node: DNode; design: Design; findings: Finding[]; editable: boolean }) {
  const project = useStore((s) => s.project);
  const updateEquipment = useStore((s) => s.updateEquipment);
  const updateExisting = useStore((s) => s.updateExisting);
  const deleteSelection = useStore((s) => s.deleteSelection);
  const select = useStore((s) => s.select);
  const equipment = node.equipmentId ? project.equipment.find((e) => e.id === node.equipmentId) : undefined;
  const mine = findings.filter((f) => f.nodes?.includes(node.id));
  const wires = design.wires.filter((w) => w.from.node === node.id || w.to.node === node.id);
  const N = new Map(design.nodes.map((n) => [n.id, n]));
  const edit = (fn: (n: DNode) => void) =>
    updateExisting((d) => {
      const n = d.nodes.find((x) => x.id === node.id);
      if (n) fn(n);
    });
  const zones = project.profile.zones.map((z) => ({ value: z.id, label: z.name }));
  const def = NODE_DEFS[node.type];
  const data = node.data;
  return (
    <div>
      <div className="insp-kind">{def.label}</div>
      <h3>{node.label}</h3>
      {node.sublabel && <div className="insp-sub">{node.sublabel}</div>}
      {mine.length > 0 && (
        <div className="findings compact">
          {mine.map((f) => (
            <FindingItem key={f.id} f={f} />
          ))}
        </div>
      )}
      {editable ? (
        <div className="eq-edit">
          <Field label="Label" help="Name shown on the drawing.">
            <TextInput value={node.label} onChange={(v) => edit((n) => void (n.label = v))} />
          </Field>
          <Field label="Location" help="Where this component is aboard. Used for the wire lengths connected to it.">
            <Select value={node.zone} options={zones} onChange={(v) => edit((n) => void (n.zone = v))} />
          </Field>
          {node.type === 'isolator' && (
            <Field label="Isolator type" help="Diode isolators lose ~0.7 V, so batteries are undercharged with a stock regulator. FET (MOSFET) isolators have almost no loss.">
              <Select
                value={String(data.isolatorType ?? 'diode')}
                options={[
                  { value: 'diode', label: 'Diode (~0.7 V drop)' },
                  { value: 'fet', label: 'FET / MOSFET (zero-drop)' },
                ]}
                onChange={(v) =>
                  edit((n) => {
                    n.data.isolatorType = v;
                    n.sublabel = v === 'fet' ? 'FET' : 'Diode';
                  })
                }
              />
            </Field>
          )}
          {['fuse', 'breaker', 'switch', 'elci', 'contactor', 'acr', 'dcdc', 'converter', 'isolator'].includes(node.type) && (
            <Field label="Rating" help="Current rating in amps: the fuse or breaker size, or the device's continuous rating. The wire it protects must be able to carry at least this much.">
              <NumInput value={data.rating} unit="A" onChange={(v) => edit((n) => void (n.data.rating = v))} />
            </Field>
          )}
          {node.type === 'battery' && (
            <>
              <Field label="Chemistry" help="Battery type. Mixing lithium and lead-acid on the same bus is flagged as an error.">
                <Select
                  value={String(data.chemistry ?? 'agm')}
                  options={[
                    { value: 'flooded', label: 'Flooded' },
                    { value: 'agm', label: 'AGM' },
                    { value: 'gel', label: 'Gel' },
                    { value: 'lifepo4', label: 'LiFePO4' },
                  ]}
                  onChange={(v) => edit((n) => void (n.data.chemistry = v))}
                />
              </Field>
              <Field label="Capacity" help="Total bank capacity in amp-hours at the system voltage.">
                <NumInput value={data.ah as number | undefined} unit="Ah" onChange={(v) => edit((n) => void (n.data.ah = v))} />
              </Field>
            </>
          )}
          {(node.type === 'load' || node.type === 'ac-load') && !equipment && (
            <>
              <Field label="Current" help="Current the load draws while running, in amps (watts ÷ volts).">
                <NumInput value={data.amps} unit="A" onChange={(v) => edit((n) => void (n.data.amps = v))} />
              </Field>
              <Toggle checked={!!data.critical} label="Critical circuit (3% drop)" tip="Navigation, bilge and electronics circuits are held to 3% voltage drop; others 10%." onChange={(v) => edit((n) => void (n.data.critical = v))} />
              <Toggle checked={data.kind === 'bilge-pump'} label="This is a bilge pump" tip="Bilge pumps must be fed unswitched (battery side of the main switch) with their own fuse; the check enforces this." onChange={(v) => edit((n) => void (n.data.kind = v ? 'bilge-pump' : 'custom-dc'))} />
            </>
          )}
          {['alternator', 'charger', 'mppt', 'controller', 'solar-panel', 'wind-gen', 'hydro-gen', 'inverter-charger'].includes(node.type) && (
            <Field label="Output current" help="Maximum charging current this source can deliver, in amps.">
              <NumInput value={data.amps} unit="A" onChange={(v) => edit((n) => void (n.data.amps = v))} />
            </Field>
          )}
          {(node.type === 'inverter' || node.type === 'inverter-charger') && (
            <Field label="Inverter rating" help="Continuous AC output in watts. Sets the DC current it can draw (about watts ÷ volts ÷ 0.9 efficiency), and so the size of its cable and fuse.">
              <NumInput value={data.watts} unit="W" onChange={(v) => edit((n) => void (n.data.watts = v))} />
            </Field>
          )}
          {def.growable && (
            <div className="terms">
              <h4>{node.type.includes('panel') || node.type === 'fuse-block' ? 'Circuit positions' : 'Studs'}</h4>
              {node.terminals
                .filter((t) => t.id !== 'in')
                .map((t) => (
                  <div className="term-row" key={t.id}>
                    <span className="mono">{t.id}</span>
                    {(node.type.includes('panel') || node.type === 'fuse-block') && (
                      <>
                        <NumInput
                          value={t.rating}
                          unit="A"
                          onChange={(v) =>
                            edit((n) => {
                              const x = n.terminals.find((y) => y.id === t.id)!;
                              x.rating = v;
                              x.label = `${v} A${x.label?.includes('·') ? ' ·' + x.label.split('·')[1] : ''}`;
                            })
                          }
                        />
                      </>
                    )}
                    <Select
                      value={t.side}
                      options={[
                        { value: 'W', label: 'left' },
                        { value: 'E', label: 'right' },
                      ]}
                      onChange={(v) => edit((n) => void (n.terminals.find((y) => y.id === t.id)!.side = v as 'W' | 'E'))}
                    />
                  </div>
                ))}
              <button
                onClick={() =>
                  edit((n) => {
                    const panel = n.type.includes('panel') || n.type === 'fuse-block';
                    growTerminal(n, { side: 'E', rating: panel ? 15 : undefined, label: panel ? '15 A' : undefined });
                  })
                }
              >
                + Add position
              </button>
            </div>
          )}
          <div className="row-actions">
            <button className="danger" onClick={deleteSelection}>
              Delete component
            </button>
          </div>
        </div>
      ) : (
        <table className="kv">
          <tbody>
            {data.rating !== undefined && (
              <tr>
                <th>Rating</th>
                <td>
                  {data.rating} A {data.fuseClass ? `(${data.fuseClass})` : ''}
                </td>
              </tr>
            )}
            {data.amps !== undefined && (
              <tr>
                <th>Current</th>
                <td>{Number(data.amps).toFixed(1)} A</td>
              </tr>
            )}
            {data.watts !== undefined && (
              <tr>
                <th>Power</th>
                <td>{Math.round(Number(data.watts))} W</td>
              </tr>
            )}
            {data.part && (
              <tr>
                <th>Suggested part</th>
                <td>{String(data.part)}</td>
              </tr>
            )}
            <tr>
              <th>Location</th>
              <td>{project.profile.zones.find((z) => z.id === node.zone)?.name ?? node.zone}</td>
            </tr>
          </tbody>
        </table>
      )}
      {equipment && (
        <details className="eq-inline" open={!editable}>
          <summary>Equipment settings</summary>
          <EquipmentEditor e={equipment} zones={project.profile.zones} update={updateEquipment} />
        </details>
      )}
      {wires.length > 0 && (
        <div className="conn">
          <h4>Connections</h4>
          {wires.map((w) => {
            const other = N.get(w.from.node === node.id ? w.to.node : w.from.node);
            return (
              <button key={w.id} className="conn-row" onClick={() => select({ kind: 'wire', id: w.id, design: editable ? 'existing' : 'ideal' })}>
                <i className={`lw ${w.kind}`} />
                <span>{other?.label}</span>
                <span className="mono">{w.cable ?? w.gauge ?? '?'}</span>
              </button>
            );
          })}
        </div>
      )}
      <Why notes={node.notes} />
    </div>
  );
}

function WireInspector({ wire, design, findings, editable }: { wire: Wire; design: Design; findings: Finding[]; editable: boolean }) {
  const project = useStore((s) => s.project);
  const updateExisting = useStore((s) => s.updateExisting);
  const deleteSelection = useStore((s) => s.deleteSelection);
  const N = new Map(design.nodes.map((n) => [n.id, n]));
  const a = N.get(wire.from.node);
  const b = N.get(wire.to.node);
  const est = useMemo(() => estimateCurrents(design), [design]);
  const amps = wire.amps ?? est.get(wire.id);
  const volts = wire.domain === 'ac' ? acVoltsOf(project) : Number([a, b].find((n) => n?.type === 'load')?.data.volts ?? design.systemVoltage);
  const vd = wire.gauge && amps !== undefined ? vdropPct(amps, wire.lengthFt, wire.gauge, volts) : undefined;
  const amp = wire.gauge ? ampacity(wire.gauge, wire.inEngineSpace, wire.kind === 'ac') : undefined;
  const mine = findings.filter((f) => f.wires?.includes(wire.id));
  const edit = (fn: (w: Wire) => void) =>
    updateExisting((d) => {
      const w = d.wires.find((x) => x.id === wire.id);
      if (w) fn(w);
    });
  const termLabel = (n: DNode | undefined, t: string) => n?.terminals.find((x) => x.id === t)?.label ?? t;
  const kindLabel = { pos: 'DC positive', neg: 'DC negative', ac: 'AC circuit', gnd: 'Grounding', sig: 'Signal / control' }[wire.kind];
  return (
    <div>
      <div className="insp-kind">{kindLabel}</div>
      <h3>
        {a?.label} → {b?.label}
      </h3>
      <div className="insp-sub">
        {termLabel(a, wire.from.term)} → {termLabel(b, wire.to.term)}
      </div>
      {mine.length > 0 && (
        <div className="findings compact">
          {mine.map((f) => (
            <FindingItem key={f.id} f={f} />
          ))}
        </div>
      )}
      {editable ? (
        <div className="eq-edit">
          <Field label="Conductor size" help="Wire gauge as installed (AWG). Checked against the current it carries, the fuse protecting it, and voltage drop over its length.">
            <Select value={wire.gauge} options={GAUGES.map((g) => ({ value: g.awg, label: fmtGauge(g.awg) }))} onChange={(v) => edit((w) => void (w.gauge = v))} />
          </Field>
          <Field label="Run length (one way)" help="Length of this wire in feet, one way. It starts as an estimate from where the two components are; replace it with the measured run. Voltage drop is calculated over the round trip (positive + negative).">
            <NumInput
              value={wire.lengthFt}
              unit="ft"
              onChange={(v) =>
                edit((w) => {
                  w.lengthFt = v;
                  delete w.lengthEstimated;
                })
              }
            />
          </Field>
          <Field label="Conductor type" help="What this wire is: DC positive, DC negative, AC, safety ground, or a low-current signal.">
            <Select
              value={wire.kind}
              options={[
                { value: 'pos', label: 'DC positive' },
                { value: 'neg', label: 'DC negative' },
                { value: 'ac', label: 'AC circuit' },
                { value: 'gnd', label: 'Grounding' },
                { value: 'sig', label: 'Signal' },
              ]}
              onChange={(v) =>
                edit((w) => {
                  w.kind = v as Wire['kind'];
                  w.domain = v === 'ac' || v === 'gnd' ? 'ac' : 'dc';
                })
              }
            />
          </Field>
          <Toggle checked={!!wire.inEngineSpace} label="Runs through engine space" tip="Engine rooms are hot, so the wire's current rating is reduced (derated) to about 82%." onChange={(v) => edit((w) => void (w.inEngineSpace = v))} />
        </div>
      ) : null}
      <table className="kv">
        <tbody>
          <tr>
            <th>Size</th>
            <td>{wire.cable ? `${wire.cable} AWG (parallel)` : fmtGauge(wire.gauge)}</td>
          </tr>
          <tr>
            <th>Length</th>
            <td>
              {wire.lengthFt} ft one way {wire.lengthEstimated && <span className="hint">(estimated)</span>}
            </td>
          </tr>
          {amps !== undefined && (
            <tr>
              <th>Current</th>
              <td>{amps.toFixed(1)} A {wire.amps === undefined && <span className="hint">(estimated)</span>}</td>
            </tr>
          )}
          {amp !== undefined && (
            <tr>
              <th>Ampacity</th>
              <td>
                {Math.round(amp)} A{wire.inEngineSpace ? ' (engine space)' : ''}
              </td>
            </tr>
          )}
          {(wire.vdropPct ?? vd) !== undefined && (
            <tr>
              <th>Voltage drop</th>
              <td>
                {(wire.vdropPct ?? vd)!.toFixed(2)}% <span className="hint">limit {wire.vdropLimit ?? VDROP.nonCritical}%</span>
              </td>
            </tr>
          )}
          {wire.gauge && (
            <tr>
              <th>Metric</th>
              <td>{gaugeSpec(wire.gauge)?.mm2} mm²</td>
            </tr>
          )}
        </tbody>
      </table>
      {editable && (
        <div className="row-actions">
          <button className="danger" onClick={deleteSelection}>
            Delete wire
          </button>
        </div>
      )}
      <Why notes={wire.notes} />
    </div>
  );
}
