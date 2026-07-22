import { Platform } from 'react-native'
import { createSync } from 'example-todo-sync/client'

// Android emulators reach the host machine at 10.0.2.2; iOS simulators
// share the host's localhost. A device on your network needs your
// machine's LAN address here.
export const { getSyncStatus, subscribeSyncStatus, runSync } = createSync(
  Platform.OS === 'android' ? 'http://10.0.2.2:8787' : 'http://localhost:8787',
)
