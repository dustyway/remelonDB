#import <Foundation/Foundation.h>
#import <ReactCommon/RCTTurboModule.h>

/**
 * Registered via codegenConfig.ios.modulesProvider — React Native asks
 * this class for the NativeWatermelonDriver TurboModule.
 */
@interface WatermelonDriverProvider : NSObject <RCTModuleProvider>
@end
