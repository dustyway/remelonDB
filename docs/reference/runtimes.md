# Runtimes

remelonDB runs in browsers, Node, and React Native (Hermes and
JavaScriptCore). Those runtimes do not implement the same JavaScript, and
the difference is invisible to the type checker: `lib.dom` declares
everything a browser has, so code that calls a method Hermes lacks
compiles cleanly and fails on a device.

This page states what the library assumes, and what an application has to
supply.

## What the library assumes

ES2022 syntax and standard library, plus these host globals:

| Global                                                 | Used for                                       |
| ------------------------------------------------------ | ---------------------------------------------- |
| `Promise`, `queueMicrotask`                            | the write queue and every async seam           |
| `AbortController`, `AbortSignal` (`aborted`, `reason`) | cancelling a sync run when its owner goes away |
| `setTimeout`, `clearTimeout`                           | the sync controller's interval and debounce    |
| `JSON`                                                 | wire payloads and `fields_json` columns        |

Anything outside that list belongs to a driver, not to core. `URL` and
`Worker` appear in `@remelondb/driver-web` because the web driver runs
workers; no other package may reach for them.

## Known runtime gaps

**`AbortSignal.prototype.throwIfAborted` is absent on Hermes.** Browsers
have had it since early 2022 and Node since 17.3, so it typechecks and
passes every test that runs in those places. The library does not call it:
`utils/abort.ts` reads `aborted` and throws the `reason` itself. Nothing is
required of an application here, but a driver or a consumer writing its own
abort checks should do the same.

**`crypto.getRandomValues` is absent on React Native.** Hermes provides no
WebCrypto, and neither Expo SDK 57 nor React Native 0.86 installs a
polyfill: `globalThis.crypto` is `undefined` there. Record ids need random
bytes, so a React Native app supplies them. The preferred way is the
`randomSource` option, no global involved:

```ts
import * as Crypto from 'expo-crypto';

const db = await Database.open({
  driver,
  schema,
  name,
  randomSource: Crypto.getRandomValues,
});
```

Every id the database mints goes through that source, and an app that
derives ids itself calls `database.randomId()` rather than the module-level
`randomId()`, so the configured source covers those too. `expo-crypto`'s
function is free-standing; a browser's or Node's is a method and must be
bound if passed (`crypto.getRandomValues.bind(crypto)`), though on those
runtimes the ambient default already works and the option is unnecessary.

The older way still works: define the global before opening.
`react-native-get-random-values` provides it as a native module, so installing
it is a build change: rebuild Android or run `pod install`, then import it
first. Adding the import without rebuilding fails with
`TurboModuleRegistry.getEnforcing(...): 'RNGetRandomValues' could not be
found`, the JS half arriving without the native half.

`Database.open` probes whichever source it will use with one byte before
it touches the driver, so every failure shape surfaces at startup with
nothing opened, each with a message naming its fix, rather than at the
first record an app creates.

There is no `Math.random()` fallback. Ids identify records across devices,
and a library substituting a weaker source without saying so is worse than
a failure at startup: the app keeps working and nobody learns that its ids
changed quality.

## Why the tests do not catch these

vitest runs in Node and jsdom, where both APIs exist. The device lanes are
what cover Hermes: `packages/driver-rn-cpp/e2e` runs the driver conformance
suite and a sync round trip on an Android emulator. A gap that lives above
the driver and outside those steps still escapes, which is how the
`throwIfAborted` call survived to a release.

When adding code that touches a host global outside the table above, either
guard it the way `randomId` does or add the case to a device lane.
