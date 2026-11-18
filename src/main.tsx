import React from 'react';
import ReactDOM from 'react-dom/client';
// Fonts ship with the app (no request to a font service), so it looks the same with no connection.
import '@fontsource-variable/inter/wght.css';
import '@fontsource/jetbrains-mono/latin-400.css';
import '@fontsource/jetbrains-mono/latin-600.css';
import '@xyflow/react/dist/style.css';
import './styles.css';
import App from './App';
import { restoreStoredImage } from './state/imageSync';
import { startOfflineSupport } from './pwa';

const root = ReactDOM.createRoot(document.getElementById('root')!);
const start = () =>
  root.render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );

// The trace-over picture is kept outside the stored project. Put it back before anything is
// drawn or saved; this takes a few milliseconds. If that fails the app still starts.
restoreStoredImage().then(start, start);
startOfflineSupport();
