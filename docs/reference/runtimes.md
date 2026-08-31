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

| Global | Used for |
| --- | --- |
| `Promise`, `queueMicrotask` | the write queue and every async seam |
| `AbortController`, `AbortSignal` (`aborted`, `reason`) | cancelling a sync run when its owner goes away |
| `setTimeout`, `clearTimeout` | the sync controller's interval and debounce |
| `JSON` | wire payloads and `fields_json` columns |

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
polyfill: `globalThis.crypto` is `undefined` there. `randomId()` requires
it, so a React Native app provides one before opening a database. Two
ways, matching the two ways an Expo app runs.

In Expo Go, `expo-crypto` is already present and can define the global:

```ts
import * as Crypto from 'expo-crypto';

if (typeof globalThis.crypto?.getRandomValues !== 'function') {
  globalThis.crypto = { getRandomValues: Crypto.getRandomValues } as Crypto;
}
```

In a development build or a bare app, `react-native-get-random-values`
does the same as a native module, which makes installing it a build
change: rebuild Android or run `pod install`, then import it first. Adding
the import without rebuilding fails with
`TurboModuleRegistry.getEnforcing(...): 'RNGetRandomValues' could not be
found`, the JS half arriving without the native half.

`Database.open` probes the source with one byte before it touches the
driver, so both failures surface at startup with nothing opened, each with
a message naming its fix, rather than at the first record an app creates.

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
