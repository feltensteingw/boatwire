import { useMemo } from 'react';
import { circuitVolts, estimateCurrents } from '../engine/audit';
import { buildGraph } from '../engine/graph';
import { ampacity, fmtGauge, gaugeSpec, vdropPct } from '../engine/calc';
import { ruleInfo } from '../engine/rules';
import { growTerminal, NODE_DEFS } from '../model/nodeDefs';
import { AC_ENGINE_SPACE_DERATE, ENGINE_SPACE_DERATE, FUSE_CLASSES, GAUGES, INVERTER_EFFICIENCY, VDROP, type FuseClass } from '../model/standards';
import type { Design, DNode, Finding, Wire } from '../model/types';
import { acVoltsOf, useUnits } from '../state/derived';
import { awgForMetric, cableLabel, cableText, fmtLen, fromLen, lenUnit, METRIC_SIZES, metricSize, toLen } from '../model/units';
import { useStore } from '../state/store';
import { EquipmentEditor } from './Sidebar';
import { copyOf, GRID } from '../engine/drawing';
import { Field, NumInput, Select, TextInput, Toggle } from './fields';
import { FindingItem } from './Findings';
import { hasMarks } from '../engine/fixMarks';

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
        <Overview findings={findings} marked={hasMarks(design)} />
      )}
    </aside>
  );
}

function Overview({ findings, marked }: { findings: Finding[]; marked: boolean }) {
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
      <Legend marked={marked} />
      <p className="hint">Click any component or wire to see its ratings and why it's there.</p>
    </div>
  );
}

function Legend({ marked }: { marked: boolean }) {
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
      {marked && (
        <div className="fix-legend">
          <h4>Size wires &amp; fuses</h4>
          <div>
            <span className="fix-tag fix-added">NEW</span> Added: fit this part or wire
          </div>
          <div>
            <span className="fix-tag fix-upgraded">was …</span> Upgrade: a larger wire or rating than drawn
          </div>
          <div>
            <span className="fix-tag fix-set">SET</span> Had no size or rating: check what is fitted
          </div>
          <div className="hint">Everything without a tag is as you drew it. Editing a marked item removes its tag.</div>
        </div>
      )}
    </div>
  );
}

function Why({ notes }: { notes?: string[] }) {
  const units = useUnits();
  if (!notes?.length) return null;
  const uniq = [...new Set(notes)];
  return (
    <div className="why">
      <h4>Why it's wired this way</h4>
      {uniq.map((id) => {
        const r = ruleInfo(id, units);
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
  const units = project.profile.units;
  const updateEquipment = useStore((s) => s.updateEquipment);
  const updateExisting = useStore((s) => s.updateExisting);
  const deleteSelection = useStore((s) => s.deleteSelection);
  const pasteExisting = useStore((s) => s.pasteExisting);
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
  const duplicateThis = () => {
    const [copy] = pasteExisting(copyOf(design, [node.id]), { x: 3 * GRID, y: 3 * GRID });
    if (copy) select({ kind: 'node', id: copy, design: 'existing' });
  };
  if (node.type === 'note') {
    return (
      <div>
        <div className="insp-kind">Note</div>
        {editable ? (
          <div className="eq-edit">
            <Field label="Text" help="A label for anything BoatWire has no symbol for. Notes are shown on the drawing and in exported pictures. They take no part in the checks or the reports.">
              <textarea className="note-edit" rows={5} aria-label="Note text" value={node.label} onChange={(e) => edit((n) => void (n.label = e.target.value))} />
            </Field>
            <div className="row-actions">
              <button onClick={duplicateThis}>Duplicate</button>
              <button className="danger" onClick={deleteSelection}>
                Delete note
              </button>
            </div>
          </div>
        ) : (
          <p className="note-read">{node.label}</p>
        )}
      </div>
    );
  }
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
          {node.type === 'isolator' && data.isolatorType !== 'fet' && (
            <Field label="Voltage compensation" help={'How the alternator regulator is made to see battery voltage despite the ~0.7 V diode drop. If you draw a wire to the isolator\'s "E" terminal or the sense terminal of the alternator that feeds it, that also counts, as does an external regulator on that alternator.'}>
              <Select
                value={String(data.compensation ?? 'none')}
                options={[
                  { value: 'none', label: 'None / not sure' },
                  { value: 'excite', label: 'Isolator "E" terminal to alternator excitation' },
                  { value: 'sense', label: 'Alternator sense lead on the battery side' },
                ]}
                onChange={(v) =>
                  edit((n) => {
                    if (v === 'none') delete n.data.compensation;
                    else n.data.compensation = v;
                  })
                }
              />
            </Field>
          )}
          {['fuse', 'breaker', 'switch', 'elci', 'contactor', 'acr', 'dcdc', 'converter', 'isolator'].includes(node.type) && (
            <Field label="Rating" help="Current rating in amps: the fuse or breaker size, or the device's continuous rating. The wire it protects must be able to carry at least this much.">
              <NumInput
                value={data.rating}
                unit="A"
                onChange={(v) =>
                  edit((n) => {
                    n.data.rating = v;
                    if (n.type === 'fuse') n.sublabel = fuseSublabel(n);
                  })
                }
              />
            </Field>
          )}
          {node.type === 'fuse' && (
            <Field label="Fuse type" help="The kind of fuse fitted. It decides how large a short-circuit current the fuse can safely interrupt. A fuse on a lithium battery must be Class T; the check flags anything else.">
              <Select
                value={String(data.fuseClass ?? '')}
                options={[
                  { value: '', label: 'Not set' },
                  ...(Object.keys(FUSE_CLASSES) as FuseClass[]).map((c) => ({ value: c as string, label: `${FUSE_NAMES[c]} · interrupts ${FUSE_CLASSES[c].aic.toLocaleString('en-US')} A` })),
                ]}
                onChange={(v) =>
                  edit((n) => {
                    if (v) n.data.fuseClass = v;
                    else delete n.data.fuseClass;
                    n.sublabel = fuseSublabel(n);
                  })
                }
              />
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
            <Field label="Inverter rating" help={`Continuous AC output in watts. Sets the DC current it can draw (watts ÷ battery volts ÷ ${INVERTER_EFFICIENCY} efficiency, worked out at low battery voltage), and so the size of its cable and fuse.`}>
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
            <button data-tip="Add a copy of this component next to it (Ctrl+D)." onClick={duplicateThis}>
              Duplicate
            </button>
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
                <span className="mono">{cableLabel(w, units) ?? '?'}</span>
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
  const units = useUnits();
  const N = new Map(design.nodes.map((n) => [n.id, n]));
  const a = N.get(wire.from.node);
  const b = N.get(wire.to.node);
  const acVolts = acVoltsOf(project);
  const est = useMemo(() => estimateCurrents(design, acVolts), [design, acVolts]);
  const amps = wire.amps ?? est.get(wire.id);
  // the same voltage the check measures the drop against (a 12 V load, a solar array's Vmp, the AC voltage)
  const volts = useMemo(() => circuitVolts(buildGraph(design), wire, design.systemVoltage, acVolts), [design, wire, acVolts]);
  const vd = wire.gauge && amps !== undefined ? vdropPct(amps, wire.lengthFt, wire.gauge, volts) : undefined;
  // Bundling applies to DC conductors that carry current; the check ignores it on other wires.
  const bundles = wire.kind === 'pos' || wire.kind === 'neg';
  const bundled = bundles ? (wire.bundledWith ?? 0) : 0;
  const amp = wire.gauge ? ampacity(wire.gauge, wire.inEngineSpace, wire.kind === 'ac', bundled) : undefined;
  const ampNote = [wire.inEngineSpace ? 'engine space' : '', bundled ? `bundled with ${bundled} other wire${bundled === 1 ? '' : 's'}` : ''].filter(Boolean).join(', ');
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
          {units === 'metric' ? (
            <Field label="Conductor size" help="Cross-section of the wire as installed, in mm². Checked against the current it carries, the fuse protecting it, and voltage drop over its length. The checks use the nearest AWG size with no more copper, so they never flatter the wire.">
              <Select<number> value={wire.gauge ? metricSize(wire.gauge) : undefined} options={METRIC_SIZES.map((s) => ({ value: s, label: `${s} mm²` }))} onChange={(v) => edit((w) => void (w.gauge = awgForMetric(v)))} />
            </Field>
          ) : (
            <Field label="Conductor size" help="Wire gauge as installed (AWG). Checked against the current it carries, the fuse protecting it, and voltage drop over its length.">
              <Select value={wire.gauge} options={GAUGES.map((g) => ({ value: g.awg, label: fmtGauge(g.awg) }))} onChange={(v) => edit((w) => void (w.gauge = v))} />
            </Field>
          )}
          <Field label="Run length (one way)" help={`Length of this wire in ${units === 'metric' ? 'metres' : 'feet'}, one way. It starts as an estimate from where the two components are; replace it with the measured run. Voltage drop is calculated over the round trip (positive + negative).`}>
            <NumInput
              value={toLen(wire.lengthFt, units)}
              unit={lenUnit(units)}
              onChange={(v) =>
                edit((w) => {
                  w.lengthFt = fromLen(v, units);
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
          <Toggle
            checked={!!wire.inEngineSpace}
            label="Runs through engine space"
            tip={`Engine rooms are hot, so the wire's current rating is reduced (derated) to ${Math.round((wire.kind === 'ac' ? AC_ENGINE_SPACE_DERATE : ENGINE_SPACE_DERATE) * 100)}%.`}
            onChange={(v) => edit((w) => void (w.inEngineSpace = v))}
          />
          {bundles && (
            <Field
              label="Bundled with"
              help="How many other wires that carry current run in the same bundle, loom, sheath or conduit as this one. Count this circuit's own negative if it is in the same cable: a duplex cable is bundled with 1. Leave out grounding and signal wires, wires carrying less than half their rating in a bundle (most lighting and electronics), and wires used only in short bursts, such as a starter or bow thruster. 0 means it runs on its own."
            >
              <NumInput
                value={wire.bundledWith ?? 0}
                unit="others"
                min={0}
                step={1}
                onChange={(v) =>
                  edit((w) => {
                    const n = Math.max(0, Math.floor(v));
                    if (n) w.bundledWith = n;
                    else delete w.bundledWith;
                  })
                }
              />
            </Field>
          )}
        </div>
      ) : null}
      <table className="kv">
        <tbody>
          <tr>
            <th>Size</th>
            <td>{units === 'metric' || wire.cable ? `${cableText(wire, units)}${/^\d+× /.test(wire.cable ?? '') ? ' (parallel)' : ''}` : fmtGauge(wire.gauge)}</td>
          </tr>
          <tr>
            <th>Length</th>
            <td>
              {fmtLen(wire.lengthFt, units)} one way {wire.lengthEstimated && <span className="hint">(estimated)</span>}
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
                {Math.round(amp)} A{ampNote ? ` (${ampNote})` : ''}
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
              <th>{units === 'metric' ? 'Sized as' : 'Metric'}</th>
              <td>{units === 'metric' ? `${wire.gauge} AWG (${gaugeSpec(wire.gauge)?.mm2} mm²)` : `${gaugeSpec(wire.gauge)?.mm2} mm²`}</td>
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

/** Fuse types as a boat owner would recognise them. */
const FUSE_NAMES: Record<FuseClass, string> = { ATC: 'Blade (ATC / ATO)', MIDI: 'MIDI / AMI', MRBF: 'Terminal (MRBF)', ANL: 'ANL', 'Class T': 'Class T' };

/** Text under a hand-drawn fuse, kept in step with its rating and type, e.g. "300 A Class T". */
function fuseSublabel(n: DNode): string | undefined {
  return [n.data.rating ? `${n.data.rating} A` : '', n.data.fuseClass ?? ''].filter(Boolean).join(' ') || undefined;
}
