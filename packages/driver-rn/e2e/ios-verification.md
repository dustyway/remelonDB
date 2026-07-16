# iOS verification runbook

Closes the first open item in `../README.md`: prove the driver's iOS
side — `modulesProvider` registration, the pod compiling the SQLite
amalgamation and C++ TurboModule, and runtime behavior on a simulator.
The Android twin of this run is described in `README.md` here; expected
output is identical (every `WMSMOKE: ok`, `WMCONF: 50 passed, 0
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
node packages/driver-rn/scripts/fetch-sqlite.mjs   # amalgamation into cpp/vendor

# pack tarballs (workspace dep rewritten to the core tarball)
mkdir -p /tmp/packed
pnpm --filter @remelondb/core pack --pack-destination /tmp/packed
CORE_TGZ=$(ls /tmp/packed/*core*.tgz)
node -e "
  const fs = require('fs')
  const p = 'packages/driver-rn/package.json'
  const pkg = JSON.parse(fs.readFileSync(p, 'utf8'))
  pkg.dependencies['@remelondb/core'] = 'file:' + process.argv[1]
  fs.writeFileSync(p, JSON.stringify(pkg, null, 2))
" "$CORE_TGZ"
pnpm --filter @remelondb/driver-rn pack --pack-destination /tmp/packed
pnpm --filter @remelondb/driver-conformance pack --pack-destination /tmp/packed
git checkout packages/driver-rn/package.json

# scaffold the app
cd /tmp
npx @react-native-community/cli@latest init WmHarness --version 0.86.0 --pm npm --skip-install --install-pods false
cd WmHarness && npm install
npm install /tmp/packed/*core*.tgz /tmp/packed/*driver-rn*.tgz /tmp/packed/*driver-conformance*.tgz

# drop in the test app (from the repo checkout)
cp <repo>/packages/driver-rn/e2e/{App.tsx,vitest-shim.ts,metro.config.js} .
```

The e2e `App.tsx` imports `@remelondb/*`. The packed tarballs ship
compiled ESM (`dist/`), so no babel additions are needed — the
template's stock `babel.config.js` is correct.

## Compile (the first checklist item)

```sh
cd ios
bundle install
bundle exec pod install         # must compile: RN pods + WatermelonRnDriver
cd ..
npx xcodebuild -workspace ios/WmHarness.xcworkspace -scheme WmHarness \
  -configuration Debug -sdk iphonesimulator -derivedDataPath ios/build \
  CODE_SIGNING_ALLOWED=NO build
```

Watch for: codegen generating `WatermelonDriverSpecJSI.h` from
`src/specs/`, the provider (`WatermelonDriverProvider.mm`) compiling,
and the amalgamation building with our flag set.

## Runtime (the second half)

```sh
# boot a simulator
xcrun simctl boot "iPhone 16" || xcrun simctl list devices | head
npx react-native start &        # metro, port 8081
xcrun simctl install booted ios/build/Build/Products/Debug-iphonesimulator/WmHarness.app
xcrun simctl launch --console-pty booted org.reactjs.native.example.WmHarness | grep -E "WMSMOKE|WMCONF"
```

(Simulators reach the host's metro on localhost directly — no port
forwarding needed. The bundle id is in the Xcode project; the template
default is `org.reactjs.native.example.<AppName>`.)

## On success

- Tick the iOS box in `../README.md` "Open items" and update its
  status banner and the root README status paragraph.
- Note anything that needed fixing in the commit message — the Android
  run surfaced three latent bugs; expect surprises.
