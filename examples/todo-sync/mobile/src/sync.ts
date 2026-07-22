import { Platform } from 'react-native'
import { createSync } from 'example-todo-sync/client'

// EXPO_PUBLIC_SYNC_URL (inlined at bundle time) points a device build
// at a deployed server. The fallbacks are for dev against a local
// server: Android emulators reach the host machine at 10.0.2.2; iOS
// simulators share the host's localhost.
export const { getSyncStatus, getSyncNote, subscribeSyncStatus, runSync } = createSync(
  process.env.EXPO_PUBLIC_SYNC_URL ??
    (Platform.OS === 'android' ? 'http://10.0.2.2:8787' : 'http://localhost:8787'),
)
