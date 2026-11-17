import { useEffect } from 'react';

export type ThemeId = 'auto' | 'light' | 'dark' | 'chart' | 'night' | 'blueprint' | 'contrast';

export interface ThemeInfo {
  id: ThemeId;
  label: string;
  hint: string;
}

/** Colour schemes. The colours themselves live in styles.css under :root[data-theme='…']. */
export const THEMES: ThemeInfo[] = [
  { id: 'auto', label: 'Auto (system)', hint: 'Follows your computer’s light / dark setting' },
  { id: 'light', label: 'Light', hint: 'Clean white workspace' },
  { id: 'dark', label: 'Dark', hint: 'Easy on the eyes indoors' },
  { id: 'chart', label: 'Nautical chart', hint: 'Warm paper tones, like a paper chart' },
  { id: 'night', label: 'Night watch (red)', hint: 'Dim red tones that preserve night vision at the nav station' },
  { id: 'blueprint', label: 'Blueprint', hint: 'White linework on blueprint blue' },
  { id: 'contrast', label: 'High contrast', hint: 'Maximum legibility in bright sun or for low vision' },
];

/** Set data-theme on <html>; 'auto' resolves to light/dark and tracks the OS setting live. */
export function useApplyTheme(theme: ThemeId) {
  useEffect(() => {
    const root = document.documentElement;
    if (theme !== 'auto') {
      root.dataset.theme = theme;
      return;
    }
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const apply = () => (root.dataset.theme = mq.matches ? 'dark' : 'light');
    apply();
    mq.addEventListener('change', apply);
    return () => mq.removeEventListener('change', apply);
  }, [theme]);
}
