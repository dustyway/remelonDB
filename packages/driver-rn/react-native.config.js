/**
 * Autolinking config: registers the pure C++ TurboModule on Android
 * (the CLI generates the module-provider glue and adds our CMake target
 * to the app build). iOS registration goes through
 * codegenConfig.ios.modulesProvider in package.json.
 */
module.exports = {
  dependency: {
    platforms: {
      android: {
        cxxModuleCMakeListsModuleName: 'watermelon-driver',
        cxxModuleCMakeListsPath: '../cpp/CMakeLists.txt',
        cxxModuleHeaderName: 'WatermelonDriver',
        // pure-cxx deps have no gradle project to run codegen, so the
        // package ships pre-generated artifacts (android/generated/jni);
        // they compile inside the app build, so RN-version drift still
        // fails loudly at compile time
        cmakeListsPath: 'generated/jni/CMakeLists.txt',
      },
    },
  },
}
