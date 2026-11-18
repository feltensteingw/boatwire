import React from 'react';
import ReactDOM from 'react-dom/client';
import '@xyflow/react/dist/style.css';
import './styles.css';
import App from './App';
import { restoreStoredImage } from './state/imageSync';

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
