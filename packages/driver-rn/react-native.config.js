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
      },
    },
  },
}
