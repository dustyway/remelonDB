# Why this directory is (almost) empty

The Android side builds entirely inside the consuming app via cxx-module
autolinking (`react-native.config.js` points the CLI at
`../cpp/CMakeLists.txt`). The CLI only treats a dependency as a pure C++
module when its `android/` directory exists but contains **no
`build.gradle` and no `AndroidManifest.xml`** — shipping either one flips
detection to the classic-library path, which then requires a Java
`ReactPackage` and silently disables the C++ registration glue
(`isPureCxxDependency` in `@react-native-community/cli-config-android`).

So: this directory must exist, and must stay free of gradle/manifest
files.

`generated/jni/` holds the codegen'd spec (CMakeLists + JSI headers +
`WatermelonDriverSpec-generated.cpp`), pre-generated because a pure-cxx
dependency has no gradle project of its own to run codegen in — the
app's CMake `add_subdirectory`s it via `cmakeListsPath` in
`react-native.config.js`. Regenerate after changing the TS spec:

    node <app>/node_modules/react-native/scripts/generate-codegen-artifacts.js \
      -p <this package> -o /tmp/wmcg -t android
    cp -r /tmp/wmcg/android/app/build/generated/source/codegen/jni generated/
