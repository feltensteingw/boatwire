import { Handle, Position, type Node, type NodeProps } from '@xyflow/react';
import { memo, type MouseEvent } from 'react';
import { NODE_DEFS } from '../model/nodeDefs';
import type { DNode, Severity } from '../model/types';
import type { LaidNode, Side } from '../layout/layout';

export type SymbolData = {
  laid: LaidNode;
  severity?: Severity;
  showParts: boolean;
  manual: boolean;
};
export type SymbolFlowNode = Node<SymbolData, 'sym'>;

const POS: Record<Side, Position> = { W: Position.Left, E: Position.Right, N: Position.Top, S: Position.Bottom };

const LIGHT_KINDS = new Set(['cabin-lights', 'nav-lights', 'anchor-light', 'steaming-deck-light']);
const MOTOR_KINDS = new Set(['water-pump', 'bilge-pump', 'shower-sump', 'windlass', 'bow-thruster', 'electric-winch', 'fans', 'autopilot', 'watermaker', 'fridge', 'freezer']);

/** Compact schematic icons, 32×32, stroke = currentColor. */
export function Icon({ n }: { n: DNode }) {
  const p = { fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const };
  const t = (x: number, y: number, s: string, size = 9) => (
    <text x={x} y={y} fontSize={size} textAnchor="middle" fill="currentColor" stroke="none" fontWeight={700} fontFamily="Inter, sans-serif">
      {s}
    </text>
  );
  let body: JSX.Element;
  switch (n.type) {
    case 'battery':
      body = (
        <g {...p}>
          <rect x="3" y="9" width="26" height="17" rx="2" />
          <path d="M8 9V6h4v3M20 9V6h4v3M8 17.5h4M10 15.5v4M20 17.5h4" />
        </g>
      );
      break;
    case 'fuse':
      body = (
        <g {...p}>
          <rect x="6" y="11" width="20" height="10" rx="2" />
          <path d="M2 16h28" />
        </g>
      );
      break;
    case 'breaker':
    case 'elci':
      body = (
        <g {...p}>
          <path d="M2 20h7M23 20h7" />
          <path d="M9 20c1-9 13-9 14 0" />
          <circle cx="9" cy="20" r="1.6" />
          <circle cx="23" cy="20" r="1.6" />
          {n.type === 'elci' && t(16, 30, 'ELCI', 7)}
        </g>
      );
      break;
    case 'switch':
    case 'bilge-switch':
      body = (
        <g {...p}>
          <circle cx="16" cy="16" r="12" />
          <path d="M16 16l7-6" />
          <circle cx="16" cy="16" r="2" />
          {n.type === 'bilge-switch' && t(16, 27, 'A/O/M', 6)}
        </g>
      );
      break;
    case 'selector':
    case 'transfer-switch': {
      // one contact per input: two at y 9 and 23, three at 7, 16 and 25
      const inputs = Math.max(2, n.terminals.filter((x) => x.id.startsWith('in')).length);
      const ys = inputs === 2 ? [9, 23] : Array.from({ length: inputs }, (_, i) => 7 + (18 * i) / (inputs - 1));
      body = (
        <g {...p}>
          {ys.map((y) => (
            <circle key={y} cx="7" cy={y} r="2" />
          ))}
          <circle cx="25" cy="16" r="2" />
          <path d={`M23 15L9 ${ys[0] + 1}`} />
          {n.type === 'transfer-switch' && t(16, 30, 'ATS', 7)}
        </g>
      );
      break;
    }
    case 'shunt':
    case 'dump-load':
      body = (
        <g {...p}>
          <path d="M2 16h5l2-5 4 10 4-10 4 10 4-10 2 5h3" />
        </g>
      );
      break;
    case 'acr':
    case 'contactor':
      body = (
        <g {...p}>
          <rect x="5" y="7" width="22" height="18" rx="2" />
          <path d="M9 19c2-6 4-6 6 0s4 6 6 0" />
          {t(16, 14, n.type === 'acr' ? (n.data.trigger === 'engine-run' ? 'D+' : 'ACR') : 'K', 7)}
        </g>
      );
      break;
    case 'dcdc':
    case 'converter':
    case 'charger':
    case 'inverter':
    case 'inverter-charger':
    case 'mppt':
    case 'controller': {
      const [a, b] =
        n.type === 'charger' ? ['~', '='] : n.type === 'inverter' ? ['=', '~'] : n.type === 'inverter-charger' ? ['=', '~'] : n.type === 'mppt' ? ['☼', '='] : ['=', '='];
      body = (
        <g {...p}>
          <rect x="3" y="3" width="26" height="26" rx="3" />
          <path d="M3 29L29 3" />
          {t(10, 15, a, 11)}
          {t(22, 26, b, 11)}
        </g>
      );
      break;
    }
    case 'bms':
    case 'regulator':
      body = (
        <g {...p}>
          <rect x="6" y="6" width="20" height="20" rx="2" />
          <path d="M10 6V2M16 6V2M22 6V2M10 30v-4M16 30v-4M22 30v-4" />
          {t(16, 19, n.type === 'bms' ? 'BMS' : 'REG', 7)}
        </g>
      );
      break;
    case 'apd':
      body = (
        <g {...p}>
          <path d="M16 3v8M16 21v8M9 11h14l-7 10zM9 21h4l3-0 3 0h4" />
        </g>
      );
      break;
    case 'isolator':
      body = (
        <g {...p}>
          <path d="M2 16h6M8 16l10-7M8 16l10 7M18 9h12M18 23h12" />
          <path d="M12 9.5l4 1.2-1.6 3.6zM12 22.5l4-1.2-1.6-3.6z" fill="currentColor" />
          <path d="M18 6v6M18 20v6" />
        </g>
      );
      break;
    case 'bus-pos':
    case 'bus-neg':
    case 'ac-ground-bus':
      body = (
        <g {...p}>
          <rect x="3" y="13" width="26" height="6" rx="1" fill={n.type === 'bus-pos' ? 'var(--bus-pos)' : n.type === 'bus-neg' ? 'var(--bus-neg)' : 'var(--bus-gnd)'} stroke="none" />
          <path d="M8 13V8M16 13V8M24 13V8M8 19v5M16 19v5M24 19v5" />
        </g>
      );
      break;
    case 'dc-panel':
    case 'ac-panel':
    case 'fuse-block':
      body = (
        <g {...p}>
          <rect x="4" y="3" width="24" height="26" rx="2" />
          <path d="M8 9h8M8 15h8M8 21h8M20 9h4M20 15h4M20 21h4" />
        </g>
      );
      break;
    case 'galvanic-isolator':
      body = (
        <g {...p}>
          <path d="M2 16h4M26 16h4M6 9h20M6 23h20M6 9v14M26 9v14" />
          <path d="M11 6l5 3-5 3zM21 20l-5 3 5 3z" />
        </g>
      );
      break;
    case 'alternator':
    case 'generator':
    case 'engine':
      body = (
        <g {...p}>
          <circle cx="16" cy="16" r="12" />
          {t(16, 20, n.type === 'alternator' ? 'A' : n.type === 'generator' ? 'G' : 'M', 12)}
          {n.type === 'alternator' && <path d="M11 25c2-2 3 2 5 0s3 2 5 0" />}
        </g>
      );
      break;
    case 'solar-panel':
      body = (
        <g {...p}>
          <path d="M4 26l4-18h18l-4 18zM6 17h18M15 8l-2 18" />
        </g>
      );
      break;
    case 'wind-gen':
    case 'hydro-gen':
      body = (
        <g {...p}>
          <circle cx="16" cy="13" r="2" />
          <path d="M16 11V2M17.7 14l7.6 4.5M14.3 14l-7.6 4.5M16 15v15" />
        </g>
      );
      break;
    case 'shore-inlet':
      body = (
        <g {...p}>
          <circle cx="16" cy="16" r="12" />
          <path d="M11 12v4M21 12v4M16 20v3" />
        </g>
      );
      break;
    case 'helm-switch':
      body = (
        <g {...p}>
          <rect x="6" y="10" width="20" height="12" rx="6" />
          <path d="M10 16h4M18 16h4M16 14v4" />
        </g>
      );
      break;
    case 'load':
    case 'ac-load': {
      const k = String(n.data.kind ?? '');
      if (LIGHT_KINDS.has(k))
        body = (
          <g {...p}>
            <circle cx="16" cy="16" r="10" />
            <path d="M9 9l14 14M23 9L9 23" />
          </g>
        );
      else if (MOTOR_KINDS.has(k))
        body = (
          <g {...p}>
            <circle cx="16" cy="16" r="11" />
            {t(16, 20, 'M', 12)}
          </g>
        );
      else
        body = (
          <g {...p}>
            <rect x="3" y="7" width="26" height="18" rx="3" />
            {t(16, 19.5, String(n.data.glyph ?? (n.type === 'ac-load' ? 'AC' : 'DC')).slice(0, 4), 8)}
          </g>
        );
      if (n.type === 'ac-load') body = <g>{body}{t(28, 31, '~', 10)}</g>;
      break;
    }
    default:
      body = (
        <g {...p}>
          <rect x="4" y="4" width="24" height="24" rx="3" />
        </g>
      );
  }
  return (
    <svg width="30" height="30" viewBox="0 0 32 32" aria-hidden>
      {body}
    </svg>
  );
}

const MULTI_TERM = new Set<DNode['type']>(['isolator', 'mppt', 'dcdc', 'charger', 'inverter', 'inverter-charger', 'shunt', 'acr', 'controller', 'converter', 'alternator', 'engine', 'selector', 'transfer-switch', 'bms', 'regulator', 'apd', 'battery']);

function SymbolNodeImpl({ data, selected }: NodeProps<SymbolFlowNode>) {
  const { laid, severity, showParts, manual } = data;
  const n = laid.node;
  const isBus = n.type === 'bus-pos' || n.type === 'bus-neg' || n.type === 'ac-ground-bus';
  const isPanel = n.type === 'dc-panel' || n.type === 'ac-panel' || n.type === 'fuse-block';
  const cls = ['sym', `t-${n.type}`, `d-${n.domain}`, selected ? 'sel' : '', severity ? `sev-${severity}` : '', n.equipmentId ? 'equip' : ''].join(' ');
  const handles = laid.ports.map((pt) => (
    <Handle
      key={pt.id}
      id={pt.id}
      type="source"
      position={POS[pt.side]}
      isConnectable={manual}
      className={`h h-${pt.pol}`}
      style={{ left: pt.x, top: pt.y, right: 'auto', bottom: 'auto', transform: 'translate(-50%,-50%)' }}
    />
  ));
  const portLabels =
    isPanel || MULTI_TERM.has(n.type)
      ? laid.ports
          .filter((pt) => pt.label && (pt.side === 'E' || pt.side === 'W'))
          .filter((pt, i, arr) => arr.findIndex((q) => q.term === pt.term && q.side === pt.side) === i || isPanel)
          .map((pt) => (
            <span
              key={`l-${pt.id}`}
              className={`plabel ${pt.side === 'E' ? 'pl-e' : 'pl-w'} ${isPanel ? 'pl-panel' : ''}`}
              style={{ top: pt.y - 7, ...(pt.side === 'E' ? { right: 6 } : { left: 6 }) }}
            >
              {pt.label}
            </span>
          ))
      : null;

  if (n.type === 'note') {
    return (
      <div className={cls} style={{ width: laid.w, minHeight: laid.h }}>
        <div className="note-text">{n.label}</div>
      </div>
    );
  }
  if (isBus) {
    return (
      <div className={cls} style={{ width: laid.w, height: laid.h }} onClick={keepTerminalClicks} title={n.label}>
        <div className="bus-bar" />
        <div className="bus-label">{n.label}</div>
        {severity && <span className={`badge ${severity}`} />}
        {handles}
      </div>
    );
  }
  if (isPanel) {
    return (
      <div className={cls} style={{ width: laid.w, height: laid.h }} onClick={keepTerminalClicks}>
        <div className="panel-head">
          <div className="panel-title">{n.label}</div>
          {n.sublabel && <div className="panel-sub">{n.sublabel}</div>}
        </div>
        {portLabels}
        {laid.hiddenCircuits ? (
          <div className="panel-collapsed" data-tip="Branch circuits are collapsed. Turn on “Panel loads” to show them.">
            {laid.hiddenCircuits} circuits hidden · ~{Math.round(laid.hiddenAmps ?? 0)} A
          </div>
        ) : null}
        {severity && <span className={`badge ${severity}`} />}
        {handles}
      </div>
    );
  }
  const hasW = !!portLabels && laid.ports.some((pt) => pt.label && pt.side === 'W');
  const hasE = !!portLabels && laid.ports.some((pt) => pt.label && pt.side === 'E');
  return (
    <div className={cls} style={{ width: laid.w, height: laid.h }} onClick={keepTerminalClicks}>
      <div className="sym-body" style={{ paddingLeft: hasW && n.type !== 'battery' ? 40 : undefined, paddingRight: hasE && n.type !== 'battery' ? 40 : undefined }}>
        <span className="sym-icon">
          <Icon n={n} />
        </span>
        <div className="sym-text">
          <div className="sym-label">{n.label}</div>
          {n.sublabel && <div className="sym-sub">{n.sublabel}</div>}
          {showParts && n.data.part && <div className="sym-part">{String(n.data.part)}</div>}
        </div>
      </div>
      {laid.negHidden && <span className="neg-stub" data-tip="This item has a negative return to the negative bus; it is hidden by the Negatives setting.">⏚</span>}
      {portLabels}
      {severity && <span className={`badge ${severity}`} data-tip={`Design check: ${severity}. Click the component for details.`} />}
      {handles}
    </div>
  );
}

/**
 * A click on a terminal dot is about wiring (it starts or ends a wire), not about the component.
 * Stop it here so it does not also select the component, which would recentre the view and, on a
 * tablet or phone, slide the details panel over the terminal the user is about to tap next.
 */
function keepTerminalClicks(e: MouseEvent<HTMLDivElement>) {
  if ((e.target as HTMLElement).closest('.react-flow__handle')) e.stopPropagation();
}

export const SymbolNode = memo(SymbolNodeImpl);

export function nodeTypeLabel(n: DNode) {
  return NODE_DEFS[n.type].label;
}
