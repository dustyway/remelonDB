# @remelondb/driver-rn

The React Native `SqliteDriver`: a **pure C++ TurboModule** wrapping a
bundled SQLite amalgamation. Bridgeless/New-Architecture-native by
construction — codegen'd spec, no classic bridge module, no manual
`global.*` JSI installs, and JSI linked from React Native's **prefab**
(never compiled from source — the exact mistake that broke upstream
WatermelonDB on modern RN).

> ## Status: Android runtime-verified on emulator; iOS pending
>
> The driver builds via cxx-module autolinking inside a real RN 0.86
> app and **passes a runtime smoke suite on an Android emulator**
> (API 36): file-backed open through the JNI database-path lookup, WAL,
> typed roundtrip, atomic batch rollback, JS-catchable native errors,
> `user_version` across reopen, `destroy` incl. sidecars, a full
> `Database` end-to-end over core — **and the complete
> driver-conformance suite (50/50, the same tests the Node driver
> passes)**. Still pending: iOS compilation + registration, and reload
> teardown. Open items at the bottom.

## Requirements

- React Native **≥ 0.76** (pure C++ TurboModule support; ≥ 0.77
  recommended for cxx-module autolinking on Android)
- New Architecture enabled (bridgeless supported)

## Setup

```sh
# once, before the first native build (downloads the pinned SQLite
# amalgamation into cpp/vendor — not committed to git):
pnpm --filter @remelondb/driver-rn fetch-sqlite

# then the usual:
cd ios && pod install
```

```ts
import { Database } from '@remelondb/core'
import { RnSqliteDriver } from '@remelondb/driver-rn'

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

## Local verification (no device required)

Repeatable on any Linux/macOS machine with clang — catches spec/signature
drift against the installed RN version:

```sh
pnpm --filter @remelondb/driver-rn fetch-sqlite
RN=$(dirname $(node -e "console.log(require.resolve('react-native/package.json'))"))

# 1. codegen must accept the spec (generates WatermelonDriverSpecJSI.h)
node $RN/scripts/generate-codegen-artifacts.js -p packages/driver-rn -o /tmp/wmcg -t ios
CG=/tmp/wmcg/build/generated/ios/ReactCodegen

# 2. C++ must satisfy the generated bridging asserts
#    (stub folly/dynamic.h with an empty class — see git history)
cd packages/driver-rn/cpp
clang++ -fsyntax-only -std=c++20 -I. -Ivendor -I$CG -I<folly-stub> \
  -I$RN/ReactCommon/jsi -I$RN/ReactCommon/react/nativemodule/core \
  -I$RN/ReactCommon/callinvoker -I$RN/ReactCommon WatermelonDriver.cpp
clang++ -fsyntax-only -std=c++20 -I. -Ivendor -I$RN/ReactCommon/jsi SqliteConnection.cpp
```

## Open items

- [ ] iOS: `modulesProvider` registration + pod compiles the amalgamation
      (same C++ core as Android; needs a Mac)
- [ ] Headless JS / reload teardown (connection mutex is in place; needs
      a real reload cycle)
