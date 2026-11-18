import { lazy, Suspense, useEffect, type ReactNode } from 'react';
import { create } from 'zustand';

// The guide's content is large, so it lives in HelpGuide.tsx and loads the first time it opens.
const HelpGuidePanel = lazy(() => import('./HelpGuide'));

// ---------------------------------------------------------------- open / close state

const SEEN_KEY = 'boatwire:guide-seen';

export const useHelp = create<{ topic: string | null; open(topic?: string): void; close(): void }>((set) => ({
  topic: null,
  open: (topic = 'start') => set({ topic }),
  close: () => set({ topic: null }),
}));

/** "?" button for the header. */
export function HelpButton() {
  const open = useHelp((s) => s.open);
  return (
    <button className="help-btn" onClick={() => open()} data-tip="How-to guide: everything BoatWire does and how to use it. Shortcut: press ?" aria-label="Help and how-to guide">
      ?
    </button>
  );
}

/** Small inline "how does this work?" link that opens the guide at a topic. */
export function HelpLink({ topic, children }: { topic: string; children?: ReactNode }) {
  const open = useHelp((s) => s.open);
  return (
    <button className="link help-link" onClick={() => open(topic)}>
      {children ?? 'How does this work?'}
    </button>
  );
}

/** Mount once: keyboard shortcut, first-visit auto-open, and the (lazily loaded) guide dialog. */
export function HelpGuide() {
  const topic = useHelp((s) => s.topic);
  const open = useHelp((s) => s.open);
  const close = useHelp((s) => s.close);

  // keyboard: ? opens, Esc closes
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      const typing = t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable;
      if (e.key === '?' && !typing) {
        e.preventDefault();
        open();
      } else if (e.key === 'Escape') close();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, close]);

  // first visit: open the guide once
  useEffect(() => {
    try {
      if (!localStorage.getItem(SEEN_KEY)) {
        localStorage.setItem(SEEN_KEY, '1');
        open('start');
      }
    } catch {
      /* storage unavailable: skip */
    }
  }, [open]);

  if (!topic) return null;
  return (
    <Suspense fallback={null}>
      <HelpGuidePanel />
    </Suspense>
  );
}
