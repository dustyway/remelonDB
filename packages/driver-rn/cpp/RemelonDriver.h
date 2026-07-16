#pragma once

#if __has_include(<RemelonDriverSpecJSI.h>)
#include <RemelonDriverSpecJSI.h>
#else
#include <RemelonDriverSpec/RemelonDriverSpecJSI.h>
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
class RemelonDriver : public NativeRemelonDriverCxxSpec<RemelonDriver> {
 public:
  explicit RemelonDriver(std::shared_ptr<CallInvoker> jsInvoker)
      : NativeRemelonDriverCxxSpec(std::move(jsInvoker)) {}

  // UnsafeMixed spec params arrive as jsi::Object; UnsafeMixed returns
  // must be jsi::Object (verified against generated RemelonDriverSpecJSI.h)
  double openDatabase(jsi::Runtime& rt, std::string name);
  void close(jsi::Runtime& rt, std::string name);
  jsi::Object query(jsi::Runtime& rt, std::string name, std::string sql, jsi::Object args);
  void execute(jsi::Runtime& rt, std::string name, std::string sql, jsi::Object args);
  void executeBatch(jsi::Runtime& rt, std::string name, jsi::Object statements);
  void setUserVersion(jsi::Runtime& rt, std::string name, double version);
  void destroy(jsi::Runtime& rt, std::string name);

 private:
  remelon::SqliteConnection& connection(jsi::Runtime& rt, const std::string& name);

  std::unordered_map<std::string, std::unique_ptr<remelon::SqliteConnection>>
      connections_;
};

} // namespace facebook::react
