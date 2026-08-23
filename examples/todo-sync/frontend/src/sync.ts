import { createSync } from 'example-todo-sync/client';

export { toDemoStatus, type SyncStatus } from 'example-todo-sync/client';

// Web syncs same-origin: Vite proxies /sync to the server in dev.
export const { getSyncNote, subscribeSyncNote, attach, notifyLocalWrite } =
  createSync('');
