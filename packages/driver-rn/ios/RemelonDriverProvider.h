#import <Foundation/Foundation.h>
#import <ReactCommon/RCTTurboModule.h>

/**
 * Registered via codegenConfig.ios.modulesProvider — React Native asks
 * this class for the NativeRemelonDriver TurboModule.
 */
@interface RemelonDriverProvider : NSObject <RCTModuleProvider>
@end
