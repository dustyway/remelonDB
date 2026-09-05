# iOS verification runbook

Closes the first open item in `../README.md`: prove the driver's iOS
side — `modulesProvider` registration, the pod compiling the SQLite
amalgamation and C++ TurboModule, and runtime behavior on a simulator.
The Android twin of this run is described in `README.md` here; expected
output is identical (every `WMSMOKE: ok`, `WMCONF: 29 passed, 0
failed`, `WMSMOKE: ALL PASS`).

## Prerequisites (verify first)

- Full Xcode with an iOS simulator runtime: `xcodebuild -version`,
  `xcrun simctl list runtimes` (need an iOS runtime installed).
- Node ≥ 20 and pnpm ≥ 9 (`corepack enable` provides pnpm).
- Ruby for CocoaPods via the app template's Gemfile (`bundle install`
  handles it).

## Build the harness

```sh
git clone https://github.com/dustyway/remelonDB
cd remelonDB && pnpm install
pnpm --filter @remelondb/driver-rn-cpp fetch-sqlite

# Pack the same tarballs used by CI.
mkdir -p /tmp/packed
pnpm --filter @remelondb/core pack --pack-destination /tmp/packed
pnpm --filter @remelondb/driver-rn-cpp pack --pack-destination /tmp/packed

# Scaffold the pinned app and install the harness files.
packages/driver-rn-cpp/scripts/create-rn-harness.sh \
  --react-native 0.86.0 --cli 20.2.0 \
  --tarballs /tmp/packed --output /tmp/WmHarness
cd /tmp/WmHarness
```

The e2e `App.tsx` imports `@remelondb/*`. The packed tarballs ship
compiled ESM (`dist/`), so no babel additions are needed — the
template's stock `babel.config.js` is correct.

## Compile (the first checklist item)

```sh
cd ios
bundle install
bundle exec pod install         # must compile: RN pods + RemelonRnDriver
cd ..
xcodebuild -workspace ios/WmHarness.xcworkspace -scheme WmHarness \
  -configuration Debug -sdk iphonesimulator -derivedDataPath ios/build \
  CODE_SIGNING_ALLOWED=NO build
# plain xcodebuild, NOT `npx xcodebuild` — npx resolves to an unrelated
# npm package that swallows the build output
```

Watch for: codegen generating `RemelonDriverSpecJSI.h` from
`src/specs/`, the provider (`RemelonDriverProvider.mm`) compiling,
and the amalgamation building with our flag set.

## Runtime (the second half)

```sh
# boot a simulator (pick any available device — newer runtimes ship
# only current iPhones, e.g. iOS 26.5 has iPhone 17, not iPhone 16)
xcrun simctl list devices available
xcrun simctl boot "iPhone 17"
npx react-native start &        # metro, port 8081
xcrun simctl install booted ios/build/Build/Products/Debug-iphonesimulator/WmHarness.app
xcrun simctl launch booted org.reactjs.native.example.WmHarness
# RN ≥ 0.79 no longer forwards console.log to metro or the launch
# console — read the verdict off the screen instead:
xcrun simctl io booted screenshot screen.png
```

(Simulators reach the host's metro on localhost directly — no port
forwarding needed. The bundle id is in the Xcode project; the template
default is `org.reactjs.native.example.<AppName>`. The app renders the
same info the `WMSMOKE`/`WMCONF` logs carry: a PASS/FAIL verdict plus
one line per check, with the conformance pass/fail counts.)

## On success

- Tick the iOS box in `../README.md` "Open items" and update its
  status banner and the root README status paragraph.
- Note anything that needed fixing in the commit message — the Android
  run surfaced three latent bugs; expect surprises.
