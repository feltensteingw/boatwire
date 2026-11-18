import { Component, type ErrorInfo, type ReactNode } from 'react';
import { undo, useHistory } from '../state/history';
import { clearRecovered, recoveredData, useRecovery } from '../state/recovery';
import { useStore } from '../state/store';
import { downloadText } from './download';

const slug = (name: string) => name.replace(/[^a-z0-9]+/gi, '-').toLowerCase() || 'boat';

/** Save the boat exactly as it is in memory. Works even when the screen cannot be drawn. */
function downloadCurrentBoat() {
  const p = useStore.getState().project;
  downloadText(`${slug(p.profile.name)}.boatwire.json`, JSON.stringify(p, null, 2), 'application/json');
}

interface Props {
  /** 'view' keeps the header and menus usable; 'app' is the last line of defence around everything. */
  scope: 'app' | 'view';
  children: ReactNode;
}

/**
 * Catches a crash while drawing the screen and offers ways out, instead of leaving a blank page.
 * The boat is still in memory and in browser storage, so it can be downloaded or the last change undone.
 */
export class ErrorBoundary extends Component<Props, { error: Error | null }> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('BoatWire could not draw the screen:', error, info.componentStack);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    const retry = () => this.setState({ error: null });
    // After a new version is deployed, the parts of the app loaded on demand have new names.
    const stale = /dynamically imported module|Loading chunk|Importing a module script failed/i.test(error.message);
    return (
      <div className={`crash crash-${this.props.scope}`} role="alert">
        <h2>{stale ? 'BoatWire has been updated' : 'Something went wrong'}</h2>
        {stale ? (
          <p>This page is from an older version and could not load the part it needed. Reload to get the new version. Your boat is saved in this browser.</p>
        ) : (
          <p>
            BoatWire hit a problem and could not draw this screen. <b>Your boat has not been lost</b>: it is still saved in this browser. The usual cause is the last change made, so undoing it is the first thing to try.
          </p>
        )}
        <div className="crash-actions">
          {stale ? (
            <button className="primary" onClick={() => location.reload()}>
              Reload
            </button>
          ) : (
            <>
              <UndoAndRetry retry={retry} />
              <button onClick={retry}>Try again</button>
              <button onClick={downloadCurrentBoat}>Download my boat file</button>
              <button onClick={() => location.reload()}>Reload the page</button>
              <button
                className="danger"
                onClick={() => {
                  useStore.getState().newProject();
                  retry();
                }}
              >
                Start a new boat
              </button>
            </>
          )}
        </div>
        {!stale && (
          <>
            <p className="hint">
              "Start a new boat" can be undone. If the problem keeps coming back, download the boat file first and keep it: it holds everything you entered.
            </p>
            <details>
              <summary>Technical details</summary>
              <pre>{error.stack || error.message}</pre>
            </details>
          </>
        )}
      </div>
    );
  }
}

function UndoAndRetry({ retry }: { retry: () => void }) {
  const { undoLabel } = useHistory();
  if (!undoLabel) return null;
  return (
    <button
      className="primary"
      onClick={() => {
        undo();
        retry();
      }}
    >
      Undo “{undoLabel}”
    </button>
  );
}

/**
 * Shown under the header when the saved boat needed repairs, could not be opened at all, or
 * changes are not being stored in this browser.
 */
export function RecoveryBanner() {
  const { problem, kept, notes, notSaving } = useRecovery();
  if (!problem && !kept && !notes.length && !notSaving) return null;
  return (
    <div className="recovery" role="alert">
      {notSaving && (
        <p>
          <b>Changes are not being saved in this browser.</b> {notSaving} Use <b>File → Save project file</b> to keep a copy now. Removing or replacing the trace-over diagram frees the most space.
        </p>
      )}
      {problem ? (
        <p>
          <b>The boat saved in this browser could not be opened.</b> {problem} BoatWire has started with the example boat instead. The saved data has been kept so it is not lost.
        </p>
      ) : (
        kept && (
          <p>
            <b>Saved data that BoatWire could not open is still being kept in this browser</b> from an earlier visit. Download it if you want to keep it, then discard it.
          </p>
        )
      )}
      {notes.length > 0 && (
        <p>
          <b>The saved boat was opened with repairs:</b> {notes.join(' ')}
        </p>
      )}
      <div className="crash-actions">
        {kept && (
          <button
            onClick={() => {
              const raw = recoveredData();
              if (raw) downloadText('boatwire-recovered.json', raw, 'application/json');
            }}
          >
            Download the saved data
          </button>
        )}
        {(kept || notes.length > 0) && <button onClick={clearRecovered}>{kept ? 'Discard the saved data' : 'Dismiss'}</button>}
      </div>
    </div>
  );
}
