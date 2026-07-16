# @remelondb/driver-conformance

The executable driver contract for
[remelonDB](https://github.com/dustyway/remelonDB): one vitest suite that
every `SqliteDriver` implementation must pass. Node, web (Chromium, Firefox,
WebKit, Safari), Android, and iOS all run these same tests; passing them is
what "conforming driver" means.

App code never needs this package. It exists for driver authors, as a dev
dependency of each driver package.

## Usage

```ts
// in a driver package's vitest file
import { registerDriverConformance } from '@remelondb/driver-conformance'

registerDriverConformance({
  name: 'node (better-sqlite3)',
  createDriver: () => new NodeSqliteDriver(),
  persistence: { databaseName: () => `/tmp/db-${counter++}.db` },
})
```

Options:

- `name`: suite display name.
- `createDriver`: a fresh, unopened driver; called once per test.
- `ephemeralName` (default `':memory:'`): name for throwaway databases.
- `persistence`: unique database names so persistence semantics
  (`user_version` survival across reopen, `destroy`) can be verified, or
  `false` to skip those tests for non-persistent setups.

## What it covers

- **Contract suite**: the driver method obligations (open/close lifecycle,
  execute, atomic batch with rollback, `user_version`, error surfaces).
- **Query corpus**: the full query-semantics corpus compiled to SQL and run
  against the driver.
- **Matcher corpus**: the same corpus through the in-memory observation
  matcher and through SQL, asserting identical results (the "one
  authoritative engine" rule as an executable invariant).
- **Schema suite**: DDL setup and migrations.
- **Records suite**: the sanitization round-trip.

See [the driver contract reference](https://github.com/dustyway/remelonDB/blob/main/docs/reference/driver.md)
for the prose version of these obligations.

## License

[MIT](https://github.com/dustyway/remelonDB/blob/main/LICENSE)
