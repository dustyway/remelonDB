# @remelondb/nestjs

remelonDB sync endpoints for NestJS: `POST /sync/pull` and `POST /sync/push`,
the wire protocol's canonical HTTP binding ([sync-wire.md](../../docs/sync-wire.md)
§6) over any [`SyncStore`](../server/README.md). Every protocol outcome —
conflict and `resyncRequired` included — is HTTP 200 with the variant in the
body; only transport failures use statuses (400 malformed, 401 unauthenticated).

Tables are declared once as Zod objects — the same objects the client's
`zodTable` uses — and checked at every boundary: the push envelope for shape
and usable ids, the engine per record (an invalid record is rejected by id
while the rest of the push applies).

## Usage

```ts
import { RemelonSyncModule } from '@remelondb/nestjs'
import { createDrizzleStore } from '@remelondb/store-drizzle'
import { z } from 'zod'

const Deck = z.object({ name: z.string().min(1), source_lang: z.string(), target_lang: z.string() })

@Module({
  imports: [
    RemelonSyncModule.forRootAsync({
      imports: [DbModule],
      inject: [DRIZZLE],
      useFactory: (db: Db) => ({
        store: createDrizzleStore<string>({ db, tables: { /* ... */ } }),
        tables: { decks: Deck },
        // the authenticated principal; null answers 401
        scopeFrom: async (request) => {
          const session = await auth.api.getSession({ headers: (request as Request).headers })
          return session?.user.id ?? null
        },
      }),
    }),
  ],
})
export class AppModule {}
```

`forRoot(options)` exists for the no-DI case. Auth stays the app's: `scopeFrom`
maps a request to its scope (a Better Auth session lookup, a JWT claim), and a
null scope answers 401 before any protocol work.

`crossValidate` passes through to the engine for cross-record rules (a card
must reference a deck pushed alongside it or already owned).

## Conformance

The package's test suite runs the full backend conformance checklist through
real HTTP (NestJS app, `fetch`, in-memory store): what passes in-process must
survive the transport unchanged.
