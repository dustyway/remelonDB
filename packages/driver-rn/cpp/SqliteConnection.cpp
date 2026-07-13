#include "SqliteConnection.h"

#include <sqlite3.h>
#include <cstdio>

namespace watermelon {

SqliteConnection::SqliteConnection(std::string path) : path_(std::move(path)) {
  if (sqlite3_open(path_.c_str(), &db_) != SQLITE_OK) {
    std::string message =
        db_ ? sqlite3_errmsg(db_) : "out of memory opening database";
    if (db_) {
      sqlite3_close(db_);
      db_ = nullptr;
    }
    throw std::runtime_error("sqlite open failed (" + path_ + "): " + message);
  }
  if (path_ != ":memory:") {
    sqlite3_exec(db_, "pragma journal_mode = WAL", nullptr, nullptr, nullptr);
  }
}

SqliteConnection::~SqliteConnection() {
  close();
}

void SqliteConnection::close() {
  for (auto& [sql, stmt] : statementCache_) {
    sqlite3_finalize(stmt);
  }
  statementCache_.clear();
  if (db_) {
    sqlite3_close(db_);
    db_ = nullptr;
  }
}

void SqliteConnection::throwError(jsi::Runtime& rt, const std::string& context) {
  throw jsi::JSError(rt, context + ": " + sqlite3_errmsg(db_));
}

sqlite3_stmt* SqliteConnection::prepare(jsi::Runtime& rt, const std::string& sql) {
  auto cached = statementCache_.find(sql);
  if (cached != statementCache_.end()) {
    sqlite3_reset(cached->second);
    sqlite3_clear_bindings(cached->second);
    return cached->second;
  }
  sqlite3_stmt* stmt = nullptr;
  if (sqlite3_prepare_v2(db_, sql.c_str(), -1, &stmt, nullptr) != SQLITE_OK) {
    throwError(rt, "prepare failed");
  }
  statementCache_.emplace(sql, stmt);
  return stmt;
}

void SqliteConnection::bindArgs(
    jsi::Runtime& rt,
    sqlite3_stmt* stmt,
    const jsi::Array& args) {
  size_t count = args.size(rt);
  for (size_t i = 0; i < count; i++) {
    jsi::Value value = args.getValueAtIndex(rt, i);
    int index = static_cast<int>(i) + 1;
    int result;
    if (value.isNull() || value.isUndefined()) {
      result = sqlite3_bind_null(stmt, index);
    } else if (value.isBool()) {
      // seam-wide convention: booleans are stored as 0/1
      result = sqlite3_bind_int(stmt, index, value.getBool() ? 1 : 0);
    } else if (value.isNumber()) {
      result = sqlite3_bind_double(stmt, index, value.getNumber());
    } else if (value.isString()) {
      std::string text = value.getString(rt).utf8(rt);
      result = sqlite3_bind_text(
          stmt, index, text.c_str(), static_cast<int>(text.size()),
          SQLITE_TRANSIENT);
    } else {
      throw jsi::JSError(rt, "invalid bind value — SqlValue only");
    }
    if (result != SQLITE_OK) {
      throwError(rt, "bind failed");
    }
  }
}

void SqliteConnection::executeStatement(jsi::Runtime& rt, sqlite3_stmt* stmt) {
  int result = sqlite3_step(stmt);
  if (result != SQLITE_DONE && result != SQLITE_ROW) {
    throwError(rt, "statement failed");
  }
  sqlite3_reset(stmt);
}

jsi::Value SqliteConnection::query(
    jsi::Runtime& rt,
    const std::string& sql,
    const jsi::Array& args) {
  std::lock_guard<std::mutex> lock(mutex_);
  sqlite3_stmt* stmt = prepare(rt, sql);
  bindArgs(rt, stmt, args);

  int columnCount = sqlite3_column_count(stmt);
  std::vector<jsi::PropNameID> columns;
  columns.reserve(columnCount);
  for (int i = 0; i < columnCount; i++) {
    columns.push_back(
        jsi::PropNameID::forUtf8(rt, sqlite3_column_name(stmt, i)));
  }

  std::vector<jsi::Value> rows;
  while (true) {
    int result = sqlite3_step(stmt);
    if (result == SQLITE_DONE) {
      break;
    }
    if (result != SQLITE_ROW) {
      sqlite3_reset(stmt);
      throwError(rt, "query failed");
    }
    jsi::Object row(rt);
    for (int i = 0; i < columnCount; i++) {
      switch (sqlite3_column_type(stmt, i)) {
        case SQLITE_NULL:
          row.setProperty(rt, columns[i], jsi::Value::null());
          break;
        case SQLITE_INTEGER:
        case SQLITE_FLOAT:
          row.setProperty(rt, columns[i], sqlite3_column_double(stmt, i));
          break;
        default: { // TEXT (BLOB is not part of the seam's value vocabulary)
          const char* text =
              reinterpret_cast<const char*>(sqlite3_column_text(stmt, i));
          row.setProperty(
              rt, columns[i],
              jsi::String::createFromUtf8(rt, text ? text : ""));
        }
      }
    }
    rows.emplace_back(std::move(row));
  }
  sqlite3_reset(stmt);

  jsi::Array result(rt, rows.size());
  for (size_t i = 0; i < rows.size(); i++) {
    result.setValueAtIndex(rt, i, rows[i]);
  }
  return result;
}

void SqliteConnection::execute(
    jsi::Runtime& rt,
    const std::string& sql,
    const jsi::Array& args) {
  std::lock_guard<std::mutex> lock(mutex_);
  sqlite3_stmt* stmt = prepare(rt, sql);
  bindArgs(rt, stmt, args);
  executeStatement(rt, stmt);
}

void SqliteConnection::executeBatch(jsi::Runtime& rt, const jsi::Array& statements) {
  std::lock_guard<std::mutex> lock(mutex_);
  if (sqlite3_exec(db_, "begin", nullptr, nullptr, nullptr) != SQLITE_OK) {
    throwError(rt, "begin failed");
  }
  try {
    size_t statementCount = statements.size(rt);
    for (size_t i = 0; i < statementCount; i++) {
      jsi::Array entry =
          statements.getValueAtIndex(rt, i).asObject(rt).asArray(rt);
      std::string sql = entry.getValueAtIndex(rt, 0).asString(rt).utf8(rt);
      jsi::Array argSets =
          entry.getValueAtIndex(rt, 1).asObject(rt).asArray(rt);
      sqlite3_stmt* stmt = prepare(rt, sql);
      size_t setCount = argSets.size(rt);
      for (size_t j = 0; j < setCount; j++) {
        jsi::Array args =
            argSets.getValueAtIndex(rt, j).asObject(rt).asArray(rt);
        sqlite3_reset(stmt);
        sqlite3_clear_bindings(stmt);
        bindArgs(rt, stmt, args);
        executeStatement(rt, stmt);
      }
    }
  } catch (...) {
    sqlite3_exec(db_, "rollback", nullptr, nullptr, nullptr);
    throw;
  }
  if (sqlite3_exec(db_, "commit", nullptr, nullptr, nullptr) != SQLITE_OK) {
    sqlite3_exec(db_, "rollback", nullptr, nullptr, nullptr);
    throwError(rt, "commit failed");
  }
}

void SqliteConnection::destroyFiles() {
  std::lock_guard<std::mutex> lock(mutex_);
  close();
  if (path_ != ":memory:") {
    std::remove(path_.c_str());
    std::remove((path_ + "-wal").c_str());
    std::remove((path_ + "-shm").c_str());
  }
}

} // namespace watermelon
