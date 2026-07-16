#pragma once

#include <string>

namespace remelon {

/**
 * The one per-platform seam of the native driver: where database files
 * live. Implemented by DatabasePlatformIOS.mm / DatabasePlatformAndroid.cpp.
 * Returns an existing, writable directory (created on first call).
 */
std::string databaseDirectory();

/** ':memory:' and absolute paths pass through; bare names are resolved. */
std::string resolveDatabasePath(const std::string& name);

} // namespace remelon
