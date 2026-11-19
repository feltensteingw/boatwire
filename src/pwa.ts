// Offline support. A service worker keeps a copy of the app in the browser, so BoatWire opens
// and works with no connection (it is most useful at the boat, where there often is none).
// It also makes the app installable on a laptop, tablet or phone.

import { registerSW } from 'virtual:pwa-register';
import { toast } from './ui/toastStore';

export function startOfflineSupport() {
  if (!('serviceWorker' in navigator)) return;
  const update = registerSW({
    // A newer version has been downloaded and is waiting. Nothing changes under the user until
    // they choose to reload; otherwise it takes over the next time the app is opened.
    onNeedRefresh() {
      toast('A new version of BoatWire is ready.', { action: { label: 'Reload', run: () => void update(true) }, ms: 10 * 60 * 1000 });
    },
    onRegisterError(e: unknown) {
      console.warn('Offline support could not be set up:', e);
    },
  });
}
