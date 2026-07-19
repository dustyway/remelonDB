#include "RemelonDriver.h"

#include "DatabasePlatform.h"

namespace facebook::react {

using remelon::SqliteConnection;

static jsi::Array asArray(jsi::Runtime& rt, jsi::Object& value, const char* what) {
  if (!value.isArray(rt)) {
    throw jsi::JSError(rt, std::string("expected an array for ") + what);
  }
  return value.getArray(rt);
}

SqliteConnection& RemelonDriver::connection(
    jsi::Runtime& rt,
    const std::string& name) {
  auto found = connections_.find(name);
  if (found == connections_.end()) {
    throw jsi::JSError(rt, "database '" + name + "' is not open");
  }
  return *found->second;
}

double RemelonDriver::openDatabase(jsi::Runtime& rt, std::string name) {
  if (connections_.count(name)) {
    throw jsi::JSError(rt, "database '" + name + "' is already open");
  }
  try {
    auto conn = std::make_unique<SqliteConnection>(
        remelon::resolveDatabasePath(name));
    int userVersion = conn->userVersion(rt);
    connections_.emplace(name, std::move(conn));
    return static_cast<double>(userVersion);
  } catch (const std::runtime_error& error) {
    throw jsi::JSError(rt, error.what());
  }
}

void RemelonDriver::close(jsi::Runtime& rt, std::string name) {
  connection(rt, name); // throws if not open
  connections_.erase(name);
}

jsi::Object RemelonDriver::query(
    jsi::Runtime& rt,
    std::string name,
    std::string sql,
    jsi::Object args) {
  jsi::Array argsArray = asArray(rt, args, "query args");
  return connection(rt, name).query(rt, sql, argsArray);
}

void RemelonDriver::execute(
    jsi::Runtime& rt,
    std::string name,
    std::string sql,
    jsi::Object args) {
  jsi::Array argsArray = asArray(rt, args, "execute args");
  connection(rt, name).execute(rt, sql, argsArray);
}

void RemelonDriver::executeBatch(
    jsi::Runtime& rt,
    std::string name,
    jsi::Object statements) {
  jsi::Array statementsArray = asArray(rt, statements, "batch statements");
  connection(rt, name).executeBatch(rt, statementsArray);
}

void RemelonDriver::setUserVersion(
    jsi::Runtime& rt,
    std::string name,
    double version) {
  connection(rt, name).setUserVersion(rt, static_cast<int>(version));
}

void RemelonDriver::destroy(jsi::Runtime& rt, std::string name) {
  auto found = connections_.find(name);
  if (found != connections_.end()) {
    found->second->destroyFiles();
    connections_.erase(found);
  }
}

} // namespace facebook::react
