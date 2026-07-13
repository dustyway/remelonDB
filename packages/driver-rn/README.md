# @watermelon-rewrite/driver-rn

The React Native `SqliteDriver`: a **pure C++ TurboModule** wrapping a
bundled SQLite amalgamation. Bridgeless/New-Architecture-native by
construction — codegen'd spec, no classic bridge module, no manual
`global.*` JSI installs, and JSI linked from React Native's **prefab**
(never compiled from source — the exact mistake that broke upstream
WatermelonDB on modern RN).

> ## ⚠️ Status: verified up to syntax, not yet on device
>
> Verified without a device (see "Local verification" below): React
> Native's **codegen accepts the spec** and generates
> `WatermelonDriverSpecJSI.h`; **all C++ passes `clang++ -fsyntax-only`**
> against the real RN 0.86 headers, the real generated spec (including
> the bridging static_asserts — `UnsafeMixed` params arrive as
> `jsi::Object`), and real fbjni; the SQLite amalgamation compiles with
> our flags; `fetch-sqlite` downloads the pinned release. Still pending:
> an actual device/simulator build — linking, autolinking glue, iOS
> compilation, and runtime behavior. Checklist at the bottom.

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

## Local verification (no device required)

Repeatable on any Linux/macOS machine with clang — catches spec/signature
drift against the installed RN version:

```sh
pnpm --filter @watermelon-rewrite/driver-rn fetch-sqlite
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

## Device-verification checklist

- [x] Codegen accepts the `UnsafeMixed` spec (verified: RN 0.86 codegen
      runs clean; `UnsafeMixed` params = `jsi::Object` at the boundary)
- [x] C++ satisfies the generated spec's bridging static_asserts
      (clang++ syntax pass against real headers + generated spec)
- [x] `fetch-sqlite` pin is a real release; amalgamation compiles with
      our flag set
- [ ] Android: cxx-module autolinking generates the provider for
      `facebook::react::WatermelonDriver` and links `watermelon-driver`
- [ ] Android: `ThreadScope`/fbjni context lookup works on the JS thread
      (syntax-checked against real fbjni; runtime unproven)
- [ ] iOS: `modulesProvider` registration + pod compiles the amalgamation
- [ ] Conformance suites pass against the device build (port
      `packages/driver-node/src/*Conformance.test.ts` into an e2e app)
- [ ] Headless JS / reload teardown (connection mutex is in place; needs
      a real reload cycle)
