import { useEffect, useRef, useState } from 'react';

/**
 * One app-wide tooltip. Any element with a `data-tip` attribute shows it on hover or keyboard
 * focus after a short delay. Faster and more readable than native `title` tooltips, and themed.
 */
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
    const over = (e: MouseEvent) => show(e.target);
    const focus = (e: FocusEvent) => show(e.target);
    document.addEventListener('mouseover', over);
    document.addEventListener('focusin', focus);
    document.addEventListener('mousedown', hide);
    document.addEventListener('keydown', hide);
    window.addEventListener('scroll', hide, true);
    return () => {
      document.removeEventListener('mouseover', over);
      document.removeEventListener('focusin', focus);
      document.removeEventListener('mousedown', hide);
      document.removeEventListener('keydown', hide);
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
