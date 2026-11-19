import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent, type MouseEvent } from 'react';

/**
 * Behaviour for a panel of actions opened by a button (the File and account menus): click to
 * open and close, Escape or a click elsewhere closes it and returns focus to the button, arrow
 * keys move between its buttons, and choosing one closes it.
 *
 * Spread `trigger` on the button and `panel` on the element holding the actions. The actions
 * are ordinary buttons, so no extra roles are needed for a screen reader to announce them.
 */
export function useMenu() {
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const id = useId();

  const close = useCallback((refocus = false) => {
    setOpen(false);
    if (refocus) button.current?.focus();
  }, []);

  useEffect(() => {
    if (!open) return;
    const outside = (e: globalThis.MouseEvent) => {
      const t = e.target as Node;
      if (!panel.current?.contains(t) && !button.current?.contains(t)) close();
    };
    document.addEventListener('mousedown', outside);
    return () => document.removeEventListener('mousedown', outside);
  }, [open, close]);

  const items = () => [...(panel.current?.querySelectorAll<HTMLElement>('button:not([disabled]), select') ?? [])].filter((x) => x.offsetParent !== null);
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      return close(true);
    }
    // Leave the arrow keys alone inside a drop-down list: they change its value.
    if ((e.target as HTMLElement).tagName === 'SELECT') return;
    const list = items();
    if (!list.length) return;
    const at = list.indexOf(document.activeElement as HTMLElement);
    const go = (i: number) => {
      e.preventDefault();
      list[(i + list.length) % list.length].focus();
    };
    if (e.key === 'ArrowDown') go(at + 1);
    else if (e.key === 'ArrowUp') go(at < 0 ? list.length - 1 : at - 1);
    else if (e.key === 'Home') go(0);
    else if (e.key === 'End') go(list.length - 1);
  };

  return {
    open,
    setOpen,
    close,
    trigger: {
      ref: button,
      'aria-expanded': open,
      'aria-controls': id,
      onClick: () => setOpen((o) => !o),
      onKeyDown: (e: KeyboardEvent) => {
        if (e.key === 'ArrowDown' && !open) {
          e.preventDefault();
          setOpen(true);
          requestAnimationFrame(() => items()[0]?.focus());
        } else if (open) onKeyDown(e);
      },
    },
    panel: {
      ref: panel,
      id,
      onKeyDown,
      // Choosing an action closes the menu. (Runs after the action's own handler.)
      onClick: (e: MouseEvent) => {
        if ((e.target as HTMLElement).closest('button')) close();
      },
    },
  };
}
