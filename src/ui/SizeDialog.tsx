// What "Size wires & fuses" did to the drawing, and what it left for the owner.

import type { SizeResult } from '../engine/autosize';
import { Modal } from './Modal';

export function SizeDialog({ result, scope, onClose, onUndo }: { result: SizeResult; scope: string; onClose: () => void; onUndo?: () => void }) {
  const { counts, changes, notes, remaining } = result;
  const parts = [
    counts.fusesAdded && `${counts.fusesAdded} fuse${counts.fusesAdded === 1 ? '' : 's'} added`,
    counts.rated && `${counts.rated} rating${counts.rated === 1 ? '' : 's'} set`,
    counts.raised && `${counts.raised} raised`,
    counts.sized && `${counts.sized} wire${counts.sized === 1 ? '' : 's'} sized`,
    counts.upsized && `${counts.upsized} made larger`,
  ].filter(Boolean);
  return (
    <Modal label="Size wires and fuses" className="sizing" onClose={onClose}>
      <h3>Size wires &amp; fuses{scope ? `: ${scope}` : ''}</h3>
      <p className="sz-summary">{parts.length ? `${parts.join(', ')}.` : 'Nothing to change: every wire and fuse here is already big enough.'}</p>
      {changes.length > 0 && (
        <details open={changes.length <= 12}>
          <summary>What changed ({changes.length})</summary>
          <ul className="sz-list">
            {changes.map((c, i) => (
              <li key={i}>{c}</li>
            ))}
          </ul>
        </details>
      )}
      {notes.length > 0 && (
        <>
          <h4>Not done</h4>
          <ul className="sz-list">
            {notes.map((c, i) => (
              <li key={i}>{c}</li>
            ))}
          </ul>
        </>
      )}
      {remaining.length > 0 && (
        <>
          <h4>The design check still reports</h4>
          <p className="hint">Sizing only sets wire sizes and fuses. These need a change to the wiring itself:</p>
          <ul className="sz-list">
            {remaining.slice(0, 12).map((f) => (
              <li key={f.id} className={`sev-${f.severity}`}>
                {f.message}
              </li>
            ))}
            {remaining.length > 12 && <li>…and {remaining.length - 12} more in the Upgrade plan.</li>}
          </ul>
        </>
      )}
      <p className="hint">
        Each change is tagged on the drawing (<span className="fix-tag fix-added">NEW</span> <span className="fix-tag fix-upgraded">was …</span> <span className="fix-tag fix-set">SET</span>), so you can see
        what to buy or change and what you drew. The tags stay with the boat and print with the diagram until you press <b>Clear marks</b>. Sizes are worked out from the lengths on the drawing. Lengths BoatWire guessed from locations are marked "estimated" on each wire: enter the measured
        length and size again. Wires are never made smaller, and ratings you entered are only raised if the circuit would blow them. Every load is counted as
        running at once, so main feeders can come out larger than in the ideal design.
      </p>
      <div className="modal-foot">
        {onUndo && <button onClick={onUndo}>Undo</button>}
        <button className="primary" data-autofocus onClick={onClose}>
          OK
        </button>
      </div>
    </Modal>
  );
}
