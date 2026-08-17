#!/usr/bin/env bash
# The android-emulator-runner action executes its `script` input line by
# line under sh, so multi-line shell constructs cannot live in the
# workflow. The whole runtime smoke lives here and the workflow invokes
# this file as a single line.
set -euo pipefail

cd /tmp/WmHarness
npm start -- --reset-cache > /tmp/remelon-metro.log 2>&1 &
METRO_PID=$!
LOGCAT_PID=""
cleanup() {
  kill "$METRO_PID" 2>/dev/null || true
  [ -n "$LOGCAT_PID" ] && kill "$LOGCAT_PID" 2>/dev/null || true
}
trap cleanup EXIT

for attempt in $(seq 1 60); do
  if curl -fsS http://127.0.0.1:8081/status | grep -q 'packager-status:running'; then
    break
  fi
  if [ "$attempt" -eq 60 ]; then
    echo "::error title=Metro failed to start::See the uploaded Metro log"
    exit 1
  fi
  sleep 1
done

adb reverse tcp:8081 tcp:8081
adb install -r android/app/build/outputs/apk/debug/app-debug.apk
adb logcat -c
adb shell am force-stop com.wmharness
adb shell am start -n com.wmharness/.MainActivity

# The verdict is read from the log FILE, never from a live pipe: after
# the marker, the *:S filter means logcat may never write again, so a
# grep on the stream leaves the pipeline hanging with no SIGPIPE until
# the timeout even though the marker arrived (seen on this lane's
# second run). stdbuf keeps the file line-buffered.
: > /tmp/remelon-logcat.log
stdbuf -oL adb logcat -v brief ReactNativeJS:V "*:S" > /tmp/remelon-logcat.log 2>&1 &
LOGCAT_PID=$!

verdict=""
for _ in $(seq 1 600); do
  if grep -q 'WMSMOKE: ALL PASS' /tmp/remelon-logcat.log; then
    verdict=pass
    break
  fi
  if grep -q 'WMSMOKE: FAILED' /tmp/remelon-logcat.log; then
    verdict=fail
    break
  fi
  sleep 1
done

if [ "$verdict" = "fail" ]; then
  echo "::error title=Android runtime smoke failed::The harness reported WMSMOKE: FAILED"
  tail -n 200 /tmp/remelon-logcat.log
  exit 1
fi
if [ "$verdict" != "pass" ]; then
  echo "::error title=Android runtime smoke timed out::No terminal WMSMOKE marker appeared"
  tail -n 200 /tmp/remelon-logcat.log || true
  exit 1
fi
