import { createSync } from 'example-todo-sync/client'

// Web syncs same-origin: Vite proxies /sync to the server in dev.
export const { getSyncStatus, subscribeSyncStatus, runSync } = createSync('')
