import { useEffect, useRef, type ReactNode } from 'react';

// Whatever had the keyboard focus most recently outside any dialog. A dialog's own content can
// take focus (autoFocus) before the dialog has had a chance to note what opened it, so this is
// tracked all the time instead.
let lastOutside: HTMLElement | null = null;
if (typeof document !== 'undefined') {
  document.addEventListener('focusin', (e) => {
    const t = e.target as HTMLElement | null;
    if (t && !t.closest?.('.modal')) lastOutside = t;
  });
}

// Open dialogs, oldest first. Only the last one (the one on top) answers the keyboard, so Escape
// in a confirmation closes the confirmation and not the dialog underneath it as well.
const open: object[] = [];

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * A dialog over the app. While it is open the keyboard stays inside it (Tab wraps round),
 * Escape or a click outside closes it, and when it closes the keyboard goes back to whatever
 * opened it.
 */
export function Modal({
  label,
  onClose,
  className = '',
  alert = false,
  children,
}: {
  /** What the dialog is, for screen readers. */
  label: string;
  onClose: () => void;
  className?: string;
  /** True for a message that interrupts the user (an error or a question). */
  alert?: boolean;
  children: ReactNode;
}) {
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = box.current!;
    const active = document.activeElement as HTMLElement | null;
    const opener = active && !el.contains(active) && active !== document.body ? active : lastOutside;
    // Start inside the dialog: on whatever asked for focus, else its first control.
    if (!el.contains(document.activeElement)) (el.querySelector<HTMLElement>('[autofocus], [data-autofocus]') ?? el.querySelector<HTMLElement>(FOCUSABLE) ?? el).focus();
    const me = {};
    open.push(me);
    const onKey = (e: KeyboardEvent) => {
      if (open[open.length - 1] !== me) return;
      if (e.key === 'Escape') {
        // Nothing else (another dialog, the guide's shortcut handler) should also act on this key press.
        e.stopImmediatePropagation();
        onClose();
        return;
      }
      if (e.key !== 'Tab') return;
      const items = [...el.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((x) => x.offsetParent !== null);
      if (!items.length) return e.preventDefault();
      const first = items[0];
      const last = items[items.length - 1];
      const at = document.activeElement;
      if (e.shiftKey && (at === first || !el.contains(at))) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (at === last || !el.contains(at))) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => {
      open.splice(open.indexOf(me), 1);
      document.removeEventListener('keydown', onKey, true);
      if (opener?.isConnected) opener.focus();
    };
    // Run once per opening: onClose changing identity must not move the focus again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="modal-back" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={box} className={`modal ${className}`} role={alert ? 'alertdialog' : 'dialog'} aria-modal="true" aria-label={label} tabIndex={-1}>
        {children}
      </div>
    </div>
  );
}
