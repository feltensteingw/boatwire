import { useEffect, useRef, useState } from 'react';

/**
 * One app-wide tooltip. Any element with a `data-tip` attribute shows it on hover or keyboard
 * focus after a short delay. Faster and more readable than native `title` tooltips, and themed.
 *
 * On a touch screen there is no hover, so: press and hold anything to read its explanation
 * (the tap that would follow is cancelled), or tap the small "?" beside a field label.
 */
/** How long a finger must rest on something before its explanation appears. */
const HOLD_MS = 500;

export function TipLayer() {
  const [tip, setTip] = useState<{ text: string; x: number; y: number; above: boolean } | null>(null);
  const timer = useRef<number>();
  const current = useRef<Element | null>(null);

  useEffect(() => {
    const hide = () => {
      window.clearTimeout(timer.current);
      current.current = null;
      setTip(null);
    };
    const show = (target: EventTarget | null) => {
      const el = target instanceof Element ? target.closest('[data-tip]') : null;
      if (el === current.current) return;
      hide();
      const text = el?.getAttribute('data-tip');
      if (!el || !text) return;
      current.current = el;
      timer.current = window.setTimeout(() => {
        const r = el.getBoundingClientRect();
        const above = r.bottom + 120 > window.innerHeight;
        setTip({ text, x: Math.min(Math.max(r.left + r.width / 2, 170), window.innerWidth - 170), y: above ? r.top - 8 : r.bottom + 8, above });
      }, 350);
    };
    // Touch: a finger produces mouse and focus events too, which would pop a tooltip on every tap.
    // Remember that the last press was a finger and ignore those; touch has its own gestures below.
    let touch = false;
    const pointer = (e: PointerEvent) => (touch = e.pointerType === 'touch');
    const over = (e: MouseEvent) => !touch && show(e.target);
    const focus = (e: FocusEvent) => !touch && show(e.target);
    const down = () => !touch && hide();

    const showNow = (el: Element) => {
      hide();
      const text = el.getAttribute('data-tip');
      if (!text) return;
      current.current = el;
      const r = el.getBoundingClientRect();
      const above = r.bottom + 140 > window.innerHeight;
      setTip({ text, x: Math.min(Math.max(r.left + r.width / 2, 170), window.innerWidth - 170), y: above ? r.top - 8 : r.bottom + 8, above });
    };
    let hold: number | undefined;
    let held = false;
    const touchStart = (e: TouchEvent) => {
      held = false;
      window.clearTimeout(hold);
      if (current.current) hide(); // any new touch dismisses the tooltip that is up
      const el = e.target instanceof Element ? e.target.closest('[data-tip]') : null;
      if (!el) return;
      hold = window.setTimeout(() => {
        held = true;
        showNow(el);
      }, HOLD_MS);
    };
    const touchEnd = () => window.clearTimeout(hold);
    const click = (e: MouseEvent) => {
      // The tap that ends a press-and-hold was for reading, not for pressing the button.
      if (held) {
        held = false;
        e.preventDefault();
        e.stopPropagation();
        return;
      }
      // Tapping the "?" beside a label explains the field instead of focusing it.
      const dot = touch && e.target instanceof Element ? e.target.closest('.help-dot') : null;
      const el = dot?.closest('[data-tip]');
      if (el) {
        e.preventDefault();
        showNow(el);
      }
    };

    document.addEventListener('pointerdown', pointer, true);
    document.addEventListener('mouseover', over);
    document.addEventListener('focusin', focus);
    document.addEventListener('mousedown', down);
    document.addEventListener('keydown', hide);
    document.addEventListener('touchstart', touchStart, { passive: true });
    document.addEventListener('touchend', touchEnd);
    document.addEventListener('touchmove', touchEnd, { passive: true });
    document.addEventListener('click', click, true);
    window.addEventListener('scroll', hide, true);
    return () => {
      window.clearTimeout(hold);
      document.removeEventListener('pointerdown', pointer, true);
      document.removeEventListener('mouseover', over);
      document.removeEventListener('focusin', focus);
      document.removeEventListener('mousedown', down);
      document.removeEventListener('keydown', hide);
      document.removeEventListener('touchstart', touchStart);
      document.removeEventListener('touchend', touchEnd);
      document.removeEventListener('touchmove', touchEnd);
      document.removeEventListener('click', click, true);
      window.removeEventListener('scroll', hide, true);
    };
  }, []);

  if (!tip) return null;
  return (
    <div className={`tip ${tip.above ? 'above' : ''}`} role="tooltip" style={{ left: tip.x, top: tip.y }}>
      {tip.text}
    </div>
  );
}
