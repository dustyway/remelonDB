# @remelondb/driver-rn

The React Native driver for [remelonDB](https://github.com/dustyway/remelonDB):
a thin adapter over [`expo-sqlite`](https://docs.expo.dev/versions/latest/sdk/sqlite/),
which owns the native SQLite build on both platforms.

Install `expo-sqlite` as an Expo module and include it in the app's native
build. The driver works in Expo development builds and bare React Native
apps.

## Ids need a random source

React Native has no WebCrypto: `globalThis.crypto` is undefined on
Hermes. Record id generation requires `crypto.getRandomValues`, and
`Database.open` refuses to open without a working random source. Pass
`expo-crypto` when opening the database:

```ts
import * as Crypto from 'expo-crypto';

const db = await Database.open({
  driver,
  schema,
  name,
  randomSource: Crypto.getRandomValues,
});
```

Alternatively, install `react-native-get-random-values`, rebuild the app,
and import it before opening the database:

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
no Expo dependency, at the cost of requiring a native build. The
two export the same class name, so switching is one import change.
Choose it when you need a specific SQLite version or want zero
dependencies between remelonDB and Expo.

Both drivers are proven by the same `@remelondb/core/conformance` suite; which
one an app injects into `Database.open` is the whole difference.
