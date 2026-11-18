// Which panel is showing on a narrow screen (tablet or phone), where the equipment list and
// the details panel slide over the diagram instead of sitting beside it. Ignored on wide screens.

import { create } from 'zustand';

export type Pane = 'left' | 'main' | 'right';

/** Below this width the side panels no longer fit beside the diagram. Keep in step with styles.css. */
export const NARROW_PX = 1200;
export const isNarrow = () => typeof window !== 'undefined' && window.innerWidth < NARROW_PX;

export const usePane = create<{ pane: Pane; setPane(p: Pane): void }>((set) => ({
  pane: 'main',
  setPane: (pane) => set({ pane }),
}));
