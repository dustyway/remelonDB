import {
  createRunSync,
  createSyncController,
  type Database,
  type SyncController,
  type SyncControllerState,
} from '@remelondb/core';
import { createHttpPost, createSyncTransport } from '@remelondb/core/transport';
import { wire } from './schema';

export type SyncStatus = 'syncing' | 'synced' | 'offline';

/** The demo folds the controller's five states down to three: any
 * failure reads as "offline"; writes stay local and the next successful
 * sync pushes them. A real app would keep 'error' separate. */
export function toDemoStatus(state: SyncControllerState): SyncStatus {
  if (state.status === 'syncing') return 'syncing';
  if (state.status === 'offline' || state.status === 'error') return 'offline';
  return 'synced';
}

// Shared by the web and native clients; `base` is the only platform
// difference — web syncs same-origin (''), native needs an absolute
// host. The transport validates server responses with the same wire
// schemas the server validates requests with — neither side trusts the
// network.
export function createSync(base: string) {
  // conflicts and resyncs are the interesting moments of a sync demo —
  // hold the latest log line on screen briefly
  let note: string | null = null;
  let noteTimer: ReturnType<typeof setTimeout> | undefined;
  const noteListeners = new Set<() => void>();
  const setNote = (next: string): void => {
    note = next;
    clearTimeout(noteTimer);
    noteTimer = setTimeout(() => {
      note = null;
      for (const listener of noteListeners) listener();
    }, 6000);
    for (const listener of noteListeners) listener();
  };

  const { pullChanges, pushChanges } = createSyncTransport({
    post: createHttpPost({ baseUrl: base }),
    validatePullResult: (raw) => wire.pullResult.parse(raw),
    validatePushResult: (raw) => wire.pushResult.parse(raw),
  });

  let controller: SyncController | null = null;

  return {
    getSyncNote: (): string | null => note,
    subscribeSyncNote: (listener: () => void): (() => void) => {
      noteListeners.add(listener);
      return () => {
        noteListeners.delete(listener);
      };
    },
    /** Own a database's sync until detach runs; subscribe to the
     * returned controller via useSyncState. */
    attach: (
      db: Database,
      triggers?: (fire: () => void) => () => void,
    ): { controller: SyncController; detach: () => void } => {
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
      owned.start();
      return {
        controller: owned,
        detach: () => {
          owned.dispose();
          if (controller === owned) controller = null;
        },
      };
    },
    /** A local write happened; sync soon (debounced by the controller). */
    notifyLocalWrite: (): void => controller?.notifyLocalWrite(),
  };
}
