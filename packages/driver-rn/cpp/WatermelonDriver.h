#pragma once

#if __has_include(<WatermelonDriverSpecJSI.h>)
#include <WatermelonDriverSpecJSI.h>
#else
#include <WatermelonDriverSpec/WatermelonDriverSpecJSI.h>
#endif

#include <memory>
#include <string>
#include <unordered_map>

#include "SqliteConnection.h"

namespace facebook::react {

/**
 * Pure C++ TurboModule implementing the SqliteDriver seam's native side.
 * One instance per React instance; connections keyed by database name.
 * Lives in facebook::react so Android cxx-module autolinking can
 * instantiate it by convention.
 */
class WatermelonDriver : public NativeWatermelonDriverCxxSpec<WatermelonDriver> {
 public:
  explicit WatermelonDriver(std::shared_ptr<CallInvoker> jsInvoker)
      : NativeWatermelonDriverCxxSpec(std::move(jsInvoker)) {}

  // UnsafeMixed spec params arrive as jsi::Object; UnsafeMixed returns
  // must be jsi::Object (verified against generated WatermelonDriverSpecJSI.h)
  double openDatabase(jsi::Runtime& rt, std::string name);
  void close(jsi::Runtime& rt, std::string name);
  jsi::Object query(jsi::Runtime& rt, std::string name, std::string sql, jsi::Object args);
  void execute(jsi::Runtime& rt, std::string name, std::string sql, jsi::Object args);
  void executeBatch(jsi::Runtime& rt, std::string name, jsi::Object statements);
  void setUserVersion(jsi::Runtime& rt, std::string name, double version);
  void destroy(jsi::Runtime& rt, std::string name);

 private:
  watermelon::SqliteConnection& connection(jsi::Runtime& rt, const std::string& name);

  std::unordered_map<std::string, std::unique_ptr<watermelon::SqliteConnection>>
      connections_;
};

} // namespace facebook::react
