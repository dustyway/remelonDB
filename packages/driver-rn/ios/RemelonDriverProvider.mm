#import "RemelonDriverProvider.h"

#import "RemelonDriver.h"

@implementation RemelonDriverProvider

- (std::shared_ptr<facebook::react::TurboModule>)getTurboModule:
    (const facebook::react::ObjCTurboModule::InitParams&)params {
  return std::make_shared<facebook::react::RemelonDriver>(params.jsInvoker);
}

@end
