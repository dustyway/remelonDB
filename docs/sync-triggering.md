# When to sync

remelonDB never calls `synchronize` for you. There is no scheduler, no
timer, and no connection held open anywhere in the library. Choosing the
moments to sync is the application's job, because the answer depends on the
transport, on whether the backend can signal, on battery and data budgets,
and on whether the app is running at all.

This guide covers what those moments are. For what `synchronize` does once
called, see [reference/sync.md](reference/sync.md); for how the protocol
behaves, [sync-basics.md](sync-basics.md).

## The trigger set

Five moments, which between them cover most applications:

1. **After a local write.** Not required — any later sync pushes it — but
   it gets your own changes out promptly.
2. **On app start.**
3. **On foreground or visibility.** `visibilitychange` on web, `AppState`
   on React Native.
4. **On the network returning.** The `online` event.
5. **On a signal from the server**, if you build one.

Sync latency only matters while someone is looking. If a record changes on
one device and the user does not pick up the other for four hours, it makes
no difference whether the second device learned about it in 200
milliseconds or at the moment it was unlocked. Triggers 2 through 4 are the
moments a user arrives, which is why this set covers most applications with
no recurring work at all.

```ts
// web
addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') void runSync(db)
})
addEventListener('online', () => void runSync(db))
```

Concurrent calls for the same database coalesce — a `synchronize` arriving
while one is running joins it — so overlapping triggers need no guarding.

## Polling

`examples/todo-sync` polls every two seconds. That is demo pacing, so two
browser windows visibly converge while someone watches, and it is not a
recommendation: a two-second poll keeps a mobile device's radio awake
continuously.

If you do poll, measure the interval in minutes rather than seconds, pause
it while the app is backgrounded or the tab is hidden, and back off while
requests are failing rather than retrying into a dead network.

## Server-triggered sync

To learn about other devices' changes while idle, something must tell the
client. The transport is yours; server-sent events are the smallest thing
that works, since the browser reconnects on its own.

**The signal carries no data.** It says "pull now" and nothing else.

That rule matters. If the notification carried changes, there would
be two delivery paths for the same data and the cursor would cover only
one; a client applying out-of-band changes has no cursor to advance and no
way to know what it missed, which reintroduces the lost-write race the
opaque cursor exists to prevent (see [sync-design.md](sync-design.md)).
Signal-only keeps `synchronize` the single path and leaves the protocol
unchanged.

The server knows a commit happened when a push returns without a conflict:

```ts
const result = await handlers.push(wire.pushArgs.parse(body))
if (!('conflict' in result)) notifyScope(scope)
return respond(200, result)
```

Fan-out is in-process. With several server processes behind a load
balancer, a commit on one does not reach a listener on another without
`LISTEN`/`NOTIFY` or a message bus.

## Signals are lossy, and that is fine

A client offline misses every signal sent while it is away, and this costs
nothing. The signal carried no data, so a client that missed fifty is in
the same state as one that missed one: its cursor has not moved, and the
server still holds everything it has not seen.

Recovery comes from the reconnection triggers, including the channel's own
reconnect — `EventSource.onopen` is a reliable "I was disconnected and am
back" hook. Sync there unconditionally. One request brings the client
current however long it was away, and pushes whatever was written offline
in the same call. If it was away long enough that its cursor fell below the
server's retention floor, the pull answers `resyncRequired` and the client
rebuilds from a snapshot, keeping unpushed local work.

> Signals provide liveness. The cursor provides correctness. Every
> reconnection path syncs unconditionally.

Three things follow, all of them things not to build:

- **No per-client signal queues on the server.** That is a message queue
  with delivery semantics next to a protocol that already solves the
  problem with a cursor. Fire and forget to whoever is listening.
- **No acknowledgements.** There is nothing to acknowledge; the next pull
  asks for whatever is missing.
- **Failed delivery is not an error.** A client disappearing mid-stream is
  normal.

## Battery

A phone's cellular radio does not power down when a request finishes; it
stays in a high-power state for several seconds first. So the energy cost
of network activity is dominated by how often the radio is woken, not by
how many bytes move — a 200-byte request and a 200 KB request cost about
the same.

That reorders the obvious conclusions:

- Frequent small requests are the worst pattern. A two-second poll never
  lets the radio sleep.
- A held connection is not automatically cheaper. Keepalives wake the radio
  exactly as polls do, so a stream with a 20-second heartbeat costs more
  than a 60-second poll.
- Coalescing beats reducing. Ten requests fired together cost roughly one
  wakeup; ten spread over ten minutes cost ten.

Ranked, best first:

1. **OS-level push** (FCM, APNs) for background delivery — the system
   maintains one connection shared by every app.
2. **Pure event-driven**, with no background network at all.
3. **A long interval**, minutes, which Android's Doze batches with other
   apps' work.
4. **A held connection with a long heartbeat** — foreground only, since
   backgrounded sockets are suspended on both platforms.
5. **Short intervals or short heartbeats.**

On web this matters much less: a laptop on wifi has a smaller radio tail
and often mains power, and while the app is open the display dominates.

## Background sync is available on mobile, not on web

On mobile the app owns its SQLite file, so a push notification can wake it
and sync before the user opens it.

On web it cannot. The web driver stores data in OPFS through the sync
access handle pool, which allows one owner per origin (see
[driver-web](../packages/driver-web/README.md)). A service worker woken by
Web Push would have to open the database itself, which either fails because
a tab holds it or succeeds by taking it over — terminating that tab's
worker and rejecting its in-flight statements. Neither is acceptable as
routine background behavior. The same blocker applies to the Background
Sync API.

So on web, Web Push can tell the user something changed; it cannot land the
data. The data arrives when the tab is opened or focused, in one round
trip. Worth knowing before promising a behavior only one platform can
deliver.

## Keep a backstop

Offline detection is unreliable. `navigator.onLine` reports the network
interface rather than reachability, so it is wrong about captive portals,
dead DNS, and a server returning 502. A stream can look open while nothing
flows through it, with a proxy buffering or a NAT entry timed out.

An interval measured in minutes covers that for almost nothing. Its job is
not liveness but detecting that the liveness mechanism has quietly died. If
you hold a connection, the equivalent is a watchdog that reconnects after a
missed heartbeat — watching for silence rather than asking for data.
