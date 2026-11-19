import { DEFAULT_CURRENCY, fmtMoney, PRICE_DEFS, priceFor, type PriceDef } from '../model/prices';
import { M_PER_FT } from '../model/units';
import { useStore } from '../state/store';
import { NumInput, TextInput } from './fields';
import { Modal } from './Modal';

const GROUPS = [...new Set(PRICE_DEFS.map((d) => d.group))];
const round = (n: number) => Math.round(n * 100) / 100;

/** The price list behind the cost estimate: every entry editable, defaults marked as rough estimates. */
export function PriceList({ onClose }: { onClose: () => void }) {
  const prices = useStore((s) => s.project.prices);
  const units = useStore((s) => s.project.profile.units);
  const setPrice = useStore((s) => s.setPrice);
  const setCurrency = useStore((s) => s.setCurrency);
  const resetPrices = useStore((s) => s.resetPrices);
  const currency = prices?.currency || DEFAULT_CURRENCY;
  const changed = Object.keys(prices?.rates ?? {}).length;

  // Cable is stored per foot. In metric it is shown, and typed, per metre.
  const perMetre = (d: PriceDef) => d.basis === 'per ft' && units === 'metric';
  const shown = (d: PriceDef, perFt: number) => round(perMetre(d) ? perFt / M_PER_FT : perFt);
  const stored = (d: PriceDef, typed: number) => (perMetre(d) ? typed * M_PER_FT : typed);
  const basis = (d: PriceDef) => (perMetre(d) ? 'per m' : d.basis);

  return (
    <Modal label="Price list" onClose={onClose} className="prices">
      <div className="modal-head">
        <h3>Price list</h3>
        <button className="icon" aria-label="Close" onClick={onClose}>
          ×
        </button>
      </div>
      <div className="prices-body">
        <p className="prices-note">
          <b>These are rough estimates, not quotes.</b> The starting prices are ballpark US-dollar figures for typical marine-grade parts. They were not taken from any supplier and have not been checked. Change any of them to what you
          actually pay: costs in the bill of materials, Compare and the upgrade plan follow at once. Your prices are saved with this boat.
        </p>
        <div className="prices-tools">
          <label>
            Currency symbol <TextInput label="Currency symbol" value={currency} onChange={setCurrency} />
          </label>
          <span className="hint">Changing the symbol does not convert the numbers.</span>
          <span className="spacer" />
          <button disabled={!prices} onClick={resetPrices} data-tip="Put every price and the currency symbol back to the starting estimates. You can undo this.">
            Reset all{changed ? ` (${changed} changed)` : ''}
          </button>
        </div>
        {GROUPS.map((g) => (
          <section key={g}>
            <h4>{g}</h4>
            <table className="grid prices-table">
              <tbody>
                {PRICE_DEFS.filter((d) => d.group === g).map((d) => {
                  const own = prices?.rates?.[d.key] !== undefined;
                  return (
                    <tr key={d.key} className={own ? 'own' : ''}>
                      <th scope="row">{d.label}</th>
                      <td className="basis">{basis(d)}</td>
                      <td className="r">
                        <NumInput label={`${d.label}, ${basis(d)}`} value={shown(d, priceFor(d.key, prices)!)} min={0} step={0.01} unit={currency} onChange={(v) => setPrice(d.key, v === shown(d, d.usd) ? undefined : stored(d, v))} />
                      </td>
                      <td className="was">
                        {own && (
                          <button className="link" onClick={() => setPrice(d.key, undefined)} data-tip="Go back to the starting estimate for this line.">
                            reset to {fmtMoney(shown(d, d.usd), currency)}
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </section>
        ))}
      </div>
    </Modal>
  );
}
