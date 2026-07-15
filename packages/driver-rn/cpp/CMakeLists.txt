# Consumed by the app's autolinking via react-native.config.js
# (cxxModuleCMakeListsPath). JSI comes from React Native's prefab —
# NEVER compiled from source here (the exact mistake that broke upstream
# WatermelonDB on RN 0.76+).
cmake_minimum_required(VERSION 3.22)
project(watermelon-driver)

if(NOT EXISTS ${CMAKE_CURRENT_SOURCE_DIR}/vendor/sqlite3.c)
  message(FATAL_ERROR
    "cpp/vendor/sqlite3.c not found — run `pnpm fetch-sqlite` in "
    "@remelondb/driver-rn before building")
endif()

add_library(watermelon-driver STATIC
  WatermelonDriver.cpp
  SqliteConnection.cpp
  DatabasePlatform.cpp
  platform/DatabasePlatformAndroid.cpp
  vendor/sqlite3.c
)

target_include_directories(watermelon-driver PUBLIC
  ${CMAKE_CURRENT_SOURCE_DIR}
  ${CMAKE_CURRENT_SOURCE_DIR}/vendor
  # pre-generated codegen spec shipped with the package (see android/README.md)
  ${CMAKE_CURRENT_SOURCE_DIR}/../android/generated/jni
  ${CMAKE_CURRENT_SOURCE_DIR}/../android/generated/jni/react/renderer/components/WatermelonDriverSpec
)

# -std applies to C++ only; sqlite3.c compiles as plain C
target_compile_options(watermelon-driver PRIVATE
  -fexceptions -frtti $<$<COMPILE_LANGUAGE:CXX>:-std=c++20>
)

# Predictable, modern SQLite configuration
target_compile_definitions(watermelon-driver PRIVATE
  SQLITE_THREADSAFE=1
  SQLITE_ENABLE_FTS5
  SQLITE_DQS=0
  SQLITE_DEFAULT_MEMSTATUS=0
  SQLITE_OMIT_DEPRECATED
  SQLITE_OMIT_LOAD_EXTENSION
)

find_package(ReactAndroid REQUIRED CONFIG)
find_package(fbjni REQUIRED CONFIG)

target_link_libraries(watermelon-driver
  ReactAndroid::jsi
  ReactAndroid::reactnative
  fbjni::fbjni
)
