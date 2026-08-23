import {
  createRunSync,
  createSyncController,
  type Database,
  type SyncController,
} from '@remelondb/core';
import {
  createSyncTransport,
  readSyncResponse,
  type SyncPath,
} from '@remelondb/core/transport';
import { wire } from './schema';

export type SyncStatus = 'syncing' | 'synced' | 'offline';

// Shared by the web and native clients; `base` is the only platform
// difference — web syncs same-origin (''), native needs an absolute
// host. The transport validates server responses with the same wire
// schemas the server validates requests with — neither side trusts the
// network. The demo folds the controller's states down to three: any
// failure reads as "offline"; writes stay local and the next
// successful sync pushes them. A real app would keep 'error' separate.
export function createSync(base: string) {
  let status: SyncStatus = 'syncing';
  let note: string | null = null;
  let noteTimer: ReturnType<typeof setTimeout> | undefined;
  const listeners = new Set<() => void>();
  const notify = (): void => {
    for (const listener of listeners) listener();
  };
  const setStatus = (next: SyncStatus): void => {
    if (status === next) return;
    status = next;
    notify();
  };
  // conflicts and resyncs are the interesting moments of a sync demo —
  // hold the latest one on screen briefly
  const setNote = (next: string): void => {
    note = next;
    clearTimeout(noteTimer);
    noteTimer = setTimeout(() => {
      note = null;
      notify();
    }, 6000);
    notify();
  };

  const post = (path: SyncPath, body: unknown, signal?: AbortSignal) =>
    readSyncResponse(path, () =>
      fetch(`${base}/sync/${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal,
      }),
    );

  const { pullChanges, pushChanges } = createSyncTransport({
    post,
    validatePullResult: (raw) => wire.pullResult.parse(raw),
    validatePushResult: (raw) => wire.pushResult.parse(raw),
  });

  let controller: SyncController | null = null;

  return {
    getSyncStatus: (): SyncStatus => status,
    getSyncNote: (): string | null => note,
    subscribeSyncStatus: (listener: () => void): (() => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    /** Own a database's sync until the returned cleanup runs. */
    attach: (
      db: Database,
      triggers?: (fire: () => void) => () => void,
    ): (() => void) => {
      controller?.dispose();
      const owned = createSyncController({
        runSync: createRunSync({
          database: db,
          pullChanges,
          pushChanges,
          // sync lifecycle in the console (conflict retries, resyncs) —
          // the e2e steps assert on these lines
          log: (message) => {
            console.log(message);
            if (/conflict|resync/.test(message)) {
              setNote(message.replace(/^sync: /, ''));
            }
          },
        }),
        intervalMs: 2000,
        debounceMs: 250,
        ...(triggers ? { triggers } : {}),
      });
      controller = owned;
      const unsubscribe = owned.subscribe((state) => {
        if (state.status === 'syncing') setStatus('syncing');
        else if (state.status === 'offline' || state.status === 'error')
          setStatus('offline');
        else setStatus('synced');
      });
      owned.start();
      return () => {
        unsubscribe();
        owned.dispose();
        if (controller === owned) controller = null;
      };
    },
    /** A local write happened; sync soon (debounced by the controller). */
    notifyLocalWrite: (): void => controller?.notifyLocalWrite(),
  };
}
