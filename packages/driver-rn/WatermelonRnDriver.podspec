require "json"

package = JSON.parse(File.read(File.join(__dir__, "package.json")))

Pod::Spec.new do |s|
  s.name         = "WatermelonRnDriver"
  s.version      = package["version"]
  s.summary      = "SQLite driver for remelonDB (C++ TurboModule)"
  s.homepage     = "https://github.com/dustyway/remelonDB"
  s.license      = "MIT"
  s.authors      = "remelonDB"
  s.platforms    = { :ios => "15.1" }
  s.source       = { :git => "https://github.com/dustyway/remelonDB.git" }

  s.source_files = [
    "cpp/*.{h,cpp}",
    "cpp/vendor/sqlite3.{h,c}",
    "ios/**/*.{h,mm}",
  ]
  s.exclude_files = ["cpp/platform/DatabasePlatformAndroid.cpp"]

  s.pod_target_xcconfig = {
    "CLANG_CXX_LANGUAGE_STANDARD" => "c++20",
    "HEADER_SEARCH_PATHS" => "\"$(PODS_TARGET_SRCROOT)/cpp\" \"$(PODS_TARGET_SRCROOT)/cpp/vendor\"",
    "GCC_PREPROCESSOR_DEFINITIONS" => "$(inherited) SQLITE_THREADSAFE=1 SQLITE_ENABLE_FTS5 SQLITE_DQS=0 SQLITE_OMIT_DEPRECATED SQLITE_OMIT_LOAD_EXTENSION",
  }

  s.script_phase = {
    :name => "Check SQLite amalgamation",
    :script => 'test -f "${PODS_TARGET_SRCROOT}/cpp/vendor/sqlite3.c" || { echo "error: cpp/vendor/sqlite3.c missing — run pnpm fetch-sqlite in @remelondb/driver-rn" >&2; exit 1; }',
    :execution_position => :before_compile,
  }

  install_modules_dependencies(s)
end
