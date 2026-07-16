#include "DatabasePlatform.h"

namespace remelon {

std::string resolveDatabasePath(const std::string& name) {
  if (name == ":memory:" || (!name.empty() && name[0] == '/')) {
    return name;
  }
  return databaseDirectory() + "/" + name;
}

} // namespace remelon
