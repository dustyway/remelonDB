#include "WatermelonDriver.h"

#include "DatabasePlatform.h"

namespace facebook::react {

using watermelon::SqliteConnection;

static jsi::Array asArray(jsi::Runtime& rt, jsi::Object& value, const char* what) {
  if (!value.isArray(rt)) {
    throw jsi::JSError(rt, std::string("expected an array for ") + what);
  }
  return value.getArray(rt);
}

SqliteConnection& WatermelonDriver::connection(
    jsi::Runtime& rt,
    const std::string& name) {
  auto found = connections_.find(name);
  if (found == connections_.end()) {
    throw jsi::JSError(rt, "database '" + name + "' is not open");
  }
  return *found->second;
}

double WatermelonDriver::openDatabase(jsi::Runtime& rt, std::string name) {
  if (connections_.count(name)) {
    throw jsi::JSError(rt, "database '" + name + "' is already open");
  }
  try {
    auto conn = std::make_unique<SqliteConnection>(
        watermelon::resolveDatabasePath(name));
    int userVersion = conn->userVersion(rt);
    connections_.emplace(name, std::move(conn));
    return static_cast<double>(userVersion);
  } catch (const std::runtime_error& error) {
    throw jsi::JSError(rt, error.what());
  }
}

void WatermelonDriver::close(jsi::Runtime& rt, std::string name) {
  connection(rt, name); // throws if not open
  connections_.erase(name);
}

jsi::Object WatermelonDriver::query(
    jsi::Runtime& rt,
    std::string name,
    std::string sql,
    jsi::Object args) {
  jsi::Array argsArray = asArray(rt, args, "query args");
  return connection(rt, name).query(rt, sql, argsArray);
}

void WatermelonDriver::execute(
    jsi::Runtime& rt,
    std::string name,
    std::string sql,
    jsi::Object args) {
  jsi::Array argsArray = asArray(rt, args, "execute args");
  connection(rt, name).execute(rt, sql, argsArray);
}

void WatermelonDriver::executeBatch(
    jsi::Runtime& rt,
    std::string name,
    jsi::Object statements) {
  jsi::Array statementsArray = asArray(rt, statements, "batch statements");
  connection(rt, name).executeBatch(rt, statementsArray);
}

void WatermelonDriver::setUserVersion(
    jsi::Runtime& rt,
    std::string name,
    double version) {
  connection(rt, name).setUserVersion(rt, static_cast<int>(version));
}

void WatermelonDriver::destroy(jsi::Runtime& rt, std::string name) {
  auto found = connections_.find(name);
  if (found != connections_.end()) {
    found->second->destroyFiles();
    connections_.erase(found);
  }
}

} // namespace facebook::react
