#pragma once

#include <jsi/jsi.h>
#include <mutex>
#include <string>
#include <unordered_map>

struct sqlite3;
struct sqlite3_stmt;

namespace watermelon {

namespace jsi = facebook::jsi;

/**
 * One open SQLite database: prepared-statement cache (keyed by SQL text,
 * per the driver contract), JSI value binding/reading, atomic batches.
 * Guarded by a mutex — calls arrive on the JS thread, but Headless JS /
 * reload edge cases can race teardown.
 *
 * Errors are thrown as jsi::JSError so they surface as ordinary JS
 * exceptions through the synchronous TurboModule call.
 */
class SqliteConnection {
 public:
  explicit SqliteConnection(std::string path);
  ~SqliteConnection();
  SqliteConnection(const SqliteConnection&) = delete;
  SqliteConnection& operator=(const SqliteConnection&) = delete;

  int userVersion(jsi::Runtime& rt);
  void setUserVersion(jsi::Runtime& rt, int version);

  jsi::Value query(jsi::Runtime& rt, const std::string& sql, const jsi::Array& args);
  void execute(jsi::Runtime& rt, const std::string& sql, const jsi::Array& args);
  /** All statements in one transaction: commit all or roll back all. */
  void executeBatch(jsi::Runtime& rt, const jsi::Array& statements);

  /** Close and delete the database file and its -wal/-shm sidecars. */
  void destroyFiles();

  const std::string& path() const { return path_; }

 private:
  sqlite3_stmt* prepare(jsi::Runtime& rt, const std::string& sql);
  void bindArgs(jsi::Runtime& rt, sqlite3_stmt* stmt, const jsi::Array& args);
  void executeStatement(jsi::Runtime& rt, sqlite3_stmt* stmt);
  [[noreturn]] void throwError(jsi::Runtime& rt, const std::string& context);
  void close();

  std::string path_;
  sqlite3* db_ = nullptr;
  std::mutex mutex_;
  std::unordered_map<std::string, sqlite3_stmt*> statementCache_;
};

} // namespace watermelon
