# @remelondb/driver-rn

The React Native driver for [remelonDB](https://github.com/dustyway/remelonDB):
a thin adapter over [`expo-sqlite`](https://docs.expo.dev/versions/latest/sdk/sqlite/),
which owns the native SQLite build on both platforms.

Because expo-sqlite ships inside **Expo Go**, apps using this driver
need no custom native build: `expo start`, scan, done. Development
builds and bare React Native apps work the same way (expo-sqlite
installs as a regular Expo module).

## Usage

```ts
import { Database } from '@remelondb/core'
import { RnSqliteDriver } from '@remelondb/driver-rn'

const db = await Database.open({
  driver: new RnSqliteDriver(),
  schema,
  name: 'app.db',   // or ':memory:'
})
```

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
