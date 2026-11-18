// Firebase web config from VITE_FIREBASE_* environment variables (see .env.example).
// Kept separate from firebase.ts so checking whether cloud is enabled does not load the Firebase SDK.

export const config = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY as string | undefined,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN as string | undefined,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID as string | undefined,
  appId: import.meta.env.VITE_FIREBASE_APP_ID as string | undefined,
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET as string | undefined,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID as string | undefined,
};

/**
 * Development and automated tests only: use the in-memory stand-in for Firebase (fakeCloud.ts)
 * so sign-in and cloud saving can be exercised without an account or a network. Start the app
 * with VITE_CLOUD_FAKE=1. The variable is never set in a production build.
 */
export const fakeCloud = !!import.meta.env.VITE_CLOUD_FAKE;

export const cloudEnabled = fakeCloud || !!(config.apiKey && config.projectId && config.appId);
