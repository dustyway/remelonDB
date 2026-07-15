# On-device e2e: smoke + conformance

Drop-in files for a scratch RN app that runs the driver's runtime smoke
suite plus the full `@watermelon-rewrite/driver-conformance` suite
(the same 50 tests the Node driver passes) on a device or emulator,
reporting to the screen and to logcat.

## Build the harness

Same recipe as CI's `android-driver` job: pack `core`, `driver-rn`, and
`driver-conformance` as tarballs (rewriting `workspace:*` deps to the
tarball paths), `npx @react-native-community/cli init WmHarness
--version 0.86.0`, install the tarballs, then copy these four files over
the app's own:

- `App.tsx` — the test runner UI; logs `WMSMOKE:` / `WMCONF:` lines
- `vitest-shim.ts` — minimal describe/it/expect so the conformance
  suite runs without vitest
- `metro.config.js` — aliases `vitest` to the shim
- `babel.config.js` — adds `@babel/plugin-transform-export-namespace-from`
  (the packages ship TS source; Metro needs it for `export * as Q`)

## Run

```sh
cd android && ./gradlew assembleDebug
adb install -r app/build/outputs/apk/debug/app-debug.apk
adb reverse tcp:8081 tcp:8081 && npx react-native start &
adb shell am start -n com.wmharness/.MainActivity
adb logcat -s ReactNativeJS:* | grep -E "WMSMOKE|WMCONF"
```

Expected: every `WMSMOKE: ok` line, `WMCONF: 50 passed, 0 failed`,
then `WMSMOKE: ALL PASS`.
