# @watermelon-rewrite/driver-rn

The React Native `SqliteDriver`: a **pure C++ TurboModule** wrapping a
bundled SQLite amalgamation. Bridgeless/New-Architecture-native by
construction — codegen'd spec, no classic bridge module, no manual
`global.*` JSI installs, and JSI linked from React Native's **prefab**
(never compiled from source — the exact mistake that broke upstream
WatermelonDB on modern RN).

> ## ⚠️ Status: not yet verified on device
>
> This package was authored on a machine without an Android NDK or Xcode.
> The TypeScript side typechecks against the seam; the native side is
> written to current RN documentation (pure C++ TurboModules, cxx-module
> autolinking, `ios.modulesProvider`) but **has not been compiled or run
> on a device yet**. Expect a shakedown pass on real toolchains before
> first use. Known verification points are listed at the bottom.

## Requirements

- React Native **≥ 0.76** (pure C++ TurboModule support; ≥ 0.77
  recommended for cxx-module autolinking on Android)
- New Architecture enabled (bridgeless supported)

## Setup

```sh
# once, before the first native build (downloads the pinned SQLite
# amalgamation into cpp/vendor — not committed to git):
pnpm --filter @watermelon-rewrite/driver-rn fetch-sqlite

# then the usual:
cd ios && pod install
```

```ts
import { Database } from '@watermelon-rewrite/core'
import { RnSqliteDriver } from '@watermelon-rewrite/driver-rn'

const db = await Database.open({
  driver: new RnSqliteDriver(),
  schema,
  migrations,
  modelClasses: [Task, Project],
  name: 'app.db', // resolved into the app's database directory
})
```

## How it's put together

| Piece | Role |
| --- | --- |
| `src/specs/NativeWatermelonDriver.ts` | codegen spec — synchronous methods (SQLite runs in-process on the JS thread, like upstream's JSI mode; Promises are added in TS) |
| `src/RnSqliteDriver.ts` | the seam implementation over the native module |
| `cpp/WatermelonDriver.{h,cpp}` | the C++ TurboModule (in `facebook::react` for autolinking); connections keyed by name |
| `cpp/SqliteConnection.{h,cpp}` | sqlite3 wrapper: statement cache, JSI binding/reading, atomic batches with rollback, WAL, destroy incl. sidecars |
| `cpp/DatabasePlatform.*`, `cpp/platform/`, `ios/DatabasePlatformIOS.mm` | the one platform seam: where database files live (Android `Context.getDatabasePath` parent via JNI; iOS Application Support) |
| `react-native.config.js` | Android cxx-module autolinking (CLI generates the provider glue, adds `cpp/CMakeLists.txt` to the app build) |
| `codegenConfig.ios.modulesProvider` + `ios/WatermelonDriverProvider.mm` | iOS module registration |
| `scripts/fetch-sqlite.mjs` | pins one SQLite version for both platforms (FTS5 on, `SQLITE_DQS=0`, no load-extension) |

Booleans bind as 0/1 (the seam-wide convention), rows come back
column-keyed with `null | number | string` values, batches run in one
`BEGIN`/`COMMIT` with rollback on any failure — the same contract the
Node driver passes conformance with.

## 16 KB page alignment

SQLite compiles from source *inside the app build* (Android) — there are
no prebuilt `.so` files in this package, so Google Play's 16 KB
page-size requirement is satisfied by the app's own toolchain (AGP 8.5+ /
NDK r28 align by default). This is deliberate: shipping prebuilts is how
upstream aged out of compliance.

## Device-verification checklist

- [ ] Android: cxx-module autolinking generates the provider for
      `facebook::react::WatermelonDriver` and links `watermelon-driver`
- [ ] Android: `ThreadScope`/fbjni context lookup works on the JS thread
- [ ] iOS: `modulesProvider` registration + pod compiles the amalgamation
- [ ] Codegen accepts the `UnsafeMixed` spec on both platforms
- [ ] Conformance suites pass against the device build (port
      `packages/driver-node/src/*Conformance.test.ts` into an e2e app)
- [ ] Headless JS / reload teardown (connection mutex is in place; needs
      a real reload cycle)
