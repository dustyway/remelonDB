// iOS: database files live in Application Support (backed up per Apple
// guidance for user data; excluded from iCloud is the app's decision).
#import <Foundation/Foundation.h>

#include "DatabasePlatform.h"

namespace watermelon {

std::string databaseDirectory() {
  static std::string cached = [] {
    NSArray<NSString*>* paths = NSSearchPathForDirectoriesInDomains(
        NSApplicationSupportDirectory, NSUserDomainMask, YES);
    NSString* directory =
        [paths.firstObject stringByAppendingPathComponent:@"WatermelonDB"];
    [[NSFileManager defaultManager] createDirectoryAtPath:directory
                              withIntermediateDirectories:YES
                                               attributes:nil
                                                    error:nil];
    return std::string(directory.UTF8String);
  }();
  return cached;
}

} // namespace watermelon
