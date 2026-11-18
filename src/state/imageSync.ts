// Connects the project in the store to the picture store (imageStore.ts).

import { applyOutsideChange } from './history';
import { fetchStored, forgetAllBut, IDB_PREFIX, keep } from './imageStore';
import { useRecovery } from './recovery';
import { useStore } from './store';

/**
 * Run once, before the app is drawn. If the stored project refers to a picture in IndexedDB,
 * put the picture back into the in-memory project, so everything that reads the project
 * (the canvas, a cloud save, a project file) sees it whole.
 */
export async function restoreStoredImage(): Promise<void> {
  const u = useStore.getState().project.existing?.underlay;
  if (u?.src.startsWith(IDB_PREFIX)) {
    const data = await fetchStored(u.src);
    // Not an edit by the user: no undo step.
    applyOutsideChange(() =>
      useStore.getState().updateExisting((d) => {
        if (!d.underlay) return;
        if (data) d.underlay.src = data;
        else delete d.underlay;
      }),
    );
    if (!data) {
      useRecovery.setState((s) => ({ notes: [...s.notes, 'The trace-over diagram picture is no longer stored in this browser, so it has been removed from the drawing. Upload it again to carry on tracing.'] }));
    }
  }
  const project = useStore.getState().project;
  void forgetAllBut(project);
  void store(project);
  // From here on, store every new picture as it appears.
  useStore.subscribe((s, prev) => {
    if (s.project.existing?.underlay?.src !== prev.project.existing?.underlay?.src) void store(s.project);
  });
}

async function store(project: typeof useStore extends { getState(): { project: infer P } } ? P : never) {
  // Once the picture is safely stored, write the project to browser storage again so it shrinks to a reference.
  if (await keep(project)) useStore.setState({});
}
