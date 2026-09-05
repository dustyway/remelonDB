# @remelondb/driver-rn

The React Native driver for [remelonDB](https://github.com/dustyway/remelonDB):
a thin adapter over [`expo-sqlite`](https://docs.expo.dev/versions/latest/sdk/sqlite/),
which owns the native SQLite build on both platforms.

Because expo-sqlite ships inside **Expo Go**, apps using this driver
need no custom native build: `expo start`, scan, done. Development
builds and bare React Native apps work the same way (expo-sqlite
installs as a regular Expo module).

## Ids need a random source

React Native has no WebCrypto: `globalThis.crypto` is undefined on
Hermes. Record id generation requires `crypto.getRandomValues`, and
`Database.open` refuses to open without a working one. Two ways to
provide it, matching the two ways an Expo app runs:

**Expo Go, no native build.** `expo-crypto` ships inside Expo Go. Define
the global from it before opening the database:

```ts
import * as Crypto from 'expo-crypto';

if (typeof globalThis.crypto?.getRandomValues !== 'function') {
  globalThis.crypto = { getRandomValues: Crypto.getRandomValues } as Crypto;
}
```

**Development build or bare React Native.** `react-native-get-random-values`
is a native module: add it, rebuild the app, then import it first:

```ts
import 'react-native-get-random-values';
```

Adding that import without rebuilding fails at `Database.open` with
`'RNGetRandomValues' could not be found`. See
[runtimes.md](https://github.com/dustyway/remelonDB/blob/main/docs/reference/runtimes.md).

## Usage

```ts
import { Database } from '@remelondb/core';
import { RnSqliteDriver } from '@remelondb/driver-rn';

const db = await Database.open({
  driver: new RnSqliteDriver(),
  schema,
  name: 'app.db', // or ':memory:'
});
```

Apps should wrap the open in `createDatabaseManager` (core) and drive
UI from `useDatabaseState` (`@remelondb/core/react`) — the same
bootstrap as web, with the takeover callback simply unused on native.

Requires `expo-sqlite` (peer dependency): `npx expo install expo-sqlite`.

## The optional C++ driver

[`@remelondb/driver-rn-cpp`](../driver-rn-cpp) is the same seam
implemented as a pure C++ TurboModule with a bundled, pinned SQLite —
no expo dependency, at the cost of requiring a development build. The
two export the same class name, so switching is one import change.
Choose it when you need a specific SQLite version or want zero
dependencies between remelonDB and Expo.

Both drivers are proven by the same `@remelondb/core/conformance` suite; which
one an app injects into `Database.open` is the whole difference.
