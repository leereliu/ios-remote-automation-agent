#import <Foundation/Foundation.h>
#import <UIKit/UIKit.h>
#include <stdlib.h>
#include <math.h>

// Compiled into the runner translation unit. External requests only use HTTPS;
// the existing WDA API is reached over the device's own loopback interface.
@interface FBHTTPSQueueClient : NSObject <NSURLSessionTaskDelegate>
@property(nonatomic,strong) NSURLSession *cloud;
@property(nonatomic,strong) NSURLSession *local;
@property(nonatomic,strong) NSDictionary *config;
@property(nonatomic,strong) NSURL *directory;
@property(nonatomic,strong) NSDictionary *pending;
@property(nonatomic,copy) NSString *sessionID;
@property(nonatomic) BOOL stopped;
@property(nonatomic) NSTimeInterval started;
@property(nonatomic,strong) NSMutableArray *events;
- (void)start;
- (void)stop;
@end

@implementation FBHTTPSQueueClient
- (NSURL *)file:(NSString *)name { return [self.directory URLByAppendingPathComponent:name]; }
- (void)save:(id)object name:(NSString *)name {
  NSData *data = [NSJSONSerialization dataWithJSONObject:object options:0 error:nil];
  [data writeToURL:[self file:name] options:NSDataWritingAtomic | NSDataWritingFileProtectionCompleteUntilFirstUserAuthentication error:nil];
}
- (NSDictionary *)load:(NSString *)name {
  NSData *data = [NSData dataWithContentsOfURL:[self file:name]];
  return data ? [NSJSONSerialization JSONObjectWithData:data options:0 error:nil] : nil;
}
- (void)record:(NSString *)event details:(NSDictionary *)details {
  @synchronized (self) {
    if (!self.events) self.events = [NSMutableArray new];
    [self.events addObject:@{@"event":event,@"details":details ?: @{},@"time":@(NSDate.date.timeIntervalSince1970),@"uptime":@(NSDate.timeIntervalSinceReferenceDate-self.started)}];
    while (self.events.count > 80) [self.events removeObjectAtIndex:0];
    [self save:self.events name:@"events.json"];
  }
}
- (void)start {
  self.started = NSDate.timeIntervalSinceReferenceDate;
  self.directory = [[NSFileManager.defaultManager URLsForDirectory:NSApplicationSupportDirectory inDomains:NSUserDomainMask].firstObject URLByAppendingPathComponent:@"iPadHTTPSAgent" isDirectory:YES];
  [NSFileManager.defaultManager createDirectoryAtURL:self.directory withIntermediateDirectories:YES attributes:@{NSFileProtectionKey:NSFileProtectionCompleteUntilFirstUserAuthentication} error:nil];
  NSDictionary *env = NSProcessInfo.processInfo.environment;
  if (env[@"IPAD_QUEUE_URL"] && env[@"IPAD_DEVICE_TOKEN"] && env[@"IPAD_DEVICE_ID"]) {
    self.config = @{@"url":env[@"IPAD_QUEUE_URL"] ?: @"", @"token":env[@"IPAD_DEVICE_TOKEN"] ?: @"", @"device_id":env[@"IPAD_DEVICE_ID"] ?: @""};
  } else {
    self.config = [self load:@"config.json"];
  }
  NSURLComponents *parts = [NSURLComponents componentsWithString:self.config[@"url"] ?: @""];
  if (![parts.scheme isEqualToString:@"https"] || parts.host.length == 0 || parts.user || parts.password || parts.query || parts.fragment || (parts.port && parts.port.intValue != 443)) {
    NSLog(@"iPad HTTPS queue disabled: missing or invalid HTTPS configuration"); return;
  }
  if (![self.config[@"token"] isKindOfClass:NSString.class] || [self.config[@"token"] length] < 32 || [self.config[@"device_id"] length] == 0) return;
  // Keep the WDA interface local even when the runner is reopened without launch arguments.
  (void)setenv("USE_IP", "127.0.0.1", 1);
  [self save:self.config name:@"config.json"];
  self.pending = [self load:@"pending.json"];
  NSURLSessionConfiguration *cloudConfig = NSURLSessionConfiguration.ephemeralSessionConfiguration;
  cloudConfig.timeoutIntervalForRequest = 20;
  cloudConfig.timeoutIntervalForResource = 25;
  cloudConfig.HTTPCookieAcceptPolicy = NSHTTPCookieAcceptPolicyNever;
  cloudConfig.URLCache = nil;
  cloudConfig.requestCachePolicy = NSURLRequestReloadIgnoringLocalCacheData;
  NSOperationQueue *queue = [NSOperationQueue new]; queue.maxConcurrentOperationCount = 1;
  self.cloud = [NSURLSession sessionWithConfiguration:cloudConfig delegate:self delegateQueue:queue];
  NSURLSessionConfiguration *localConfig = NSURLSessionConfiguration.ephemeralSessionConfiguration;
  localConfig.timeoutIntervalForRequest = 50;
  localConfig.timeoutIntervalForResource = 55;
  self.local = [NSURLSession sessionWithConfiguration:localConfig];
  NSLog(@"iPad HTTPS queue started");
  [self record:@"started" details:@{}];
  [self schedule:3];
}
- (void)stop { self.stopped = YES; [self.cloud invalidateAndCancel]; [self.local invalidateAndCancel]; }
- (void)URLSession:(NSURLSession *)session task:(NSURLSessionTask *)task willPerformHTTPRedirection:(NSHTTPURLResponse *)response newRequest:(NSURLRequest *)request completionHandler:(void (^)(NSURLRequest *))completionHandler {
  // Never forward a device credential to a redirected host.
  completionHandler(nil);
}
- (void)schedule:(NSTimeInterval)delay {
  __weak typeof(self) weakSelf = self;
  dispatch_after(dispatch_time(DISPATCH_TIME_NOW,(int64_t)(delay*NSEC_PER_SEC)), dispatch_get_main_queue(), ^{ __strong typeof(weakSelf) strongSelf=weakSelf; if (strongSelf && !strongSelf.stopped) [strongSelf poll]; });
}
- (void)cloudPost:(NSString *)path body:(NSDictionary *)body completion:(void (^)(NSDictionary *, NSError *))completion {
  NSString *base = self.config[@"url"];
  while ([base hasSuffix:@"/"]) base = [base substringToIndex:base.length-1];
  NSURL *url = [NSURL URLWithString:[base stringByAppendingString:path]];
  if (!url) { completion(nil,[NSError errorWithDomain:@"Queue" code:6 userInfo:nil]); return; }
  NSMutableURLRequest *request = [NSMutableURLRequest requestWithURL:(NSURL * _Nonnull)url];
  request.HTTPMethod = @"POST";
  [request setValue:@"application/json" forHTTPHeaderField:@"Content-Type"];
  [request setValue:[@"Bearer " stringByAppendingString:self.config[@"token"] ?: @""] forHTTPHeaderField:@"Authorization"];
  request.HTTPBody = [NSJSONSerialization dataWithJSONObject:body options:0 error:nil];
  [self record:@"request" details:@{@"path":path,@"bytes":@(request.HTTPBody.length)}];
  [[self.cloud dataTaskWithRequest:request completionHandler:^(NSData *data, NSURLResponse *response, NSError *error) {
    NSInteger status = [(NSHTTPURLResponse *)response statusCode];
    [self record:@"response" details:@{@"path":path,@"status":@(status),@"error_domain":error.domain ?: @"",@"error_code":@(error.code),@"bytes":@(data.length)}];
    if (!error && (status < 200 || status >= 300)) error = [NSError errorWithDomain:@"HTTPSQueue" code:status userInfo:@{NSLocalizedDescriptionKey:@"Queue rejected request"}];
    NSDictionary *result = data && !error ? [NSJSONSerialization JSONObjectWithData:data options:0 error:&error] : nil;
    completion(result,error);
  }] resume];
}
- (void)poll {
  if (self.stopped) return;
  if (self.pending) { [self uploadPending]; return; }
  [self cloudPost:@"/v1/device/claim" body:@{@"device_id":self.config[@"device_id"] ?: @"",@"version":@"ipad-https-2",@"uptime":@(NSDate.timeIntervalSinceReferenceDate-self.started)} completion:^(NSDictionary *body, NSError *error) {
    if (error) { [self schedule:15]; return; }
    NSDictionary *task = body[@"task"];
    if (![task isKindOfClass:NSDictionary.class]) { [self schedule:5]; return; }
    NSString *identifier = task[@"id"];
    NSDictionary *payload = task[@"payload"];
    if (![identifier isKindOfClass:NSString.class] || ![payload isKindOfClass:NSDictionary.class]) { [self schedule:15]; return; }
    // Record receipt before performing UI actions. An interrupted action is never replayed.
    NSDictionary *received = [self load:@"received.json"];
    if ([received[@"id"] isEqual:identifier]) {
      [self finish:identifier value:@{@"error":@"Task was already received; result unknown. Inspect before issuing another action."} error:YES]; return;
    }
    [self save:@{@"id":identifier,@"received_at":@(NSDate.date.timeIntervalSince1970)} name:@"received.json"];
    if ([task[@"expires_at"] doubleValue] < NSDate.date.timeIntervalSince1970*1000) {
      [self finish:identifier value:@{@"error":@"Task expired before execution"} error:YES]; return;
    }
    [self execute:payload completion:^(NSDictionary *result, NSError *operationError) {
      [self finish:identifier value:result ?: @{@"error":operationError.localizedDescription ?: @"Operation failed; outcome may be unknown"} error:operationError != nil];
    }];
  }];
}
- (void)finish:(NSString *)identifier value:(NSDictionary *)value error:(BOOL)failed {
  NSData *encoded = [NSJSONSerialization dataWithJSONObject:value options:0 error:nil];
  if (!encoded || encoded.length > 780000) {
    value = @{@"error":@"Operation completed, but its result exceeded the upload limit. Inspect device state before another action."};
    failed = YES;
  }
  self.pending = @{@"id":identifier,@"status":failed ? @"error" : @"done",@"result":value};
  [self save:self.pending name:@"pending.json"];
  [self uploadPending];
}
- (void)uploadPending {
  NSDictionary *pending = self.pending;
  if (!pending) { [self schedule:5]; return; }
  [self cloudPost:@"/v1/device/result" body:pending completion:^(NSDictionary *body, NSError *error) {
    if (!error && [body[@"recorded"] boolValue]) {
      self.pending = nil;
      [NSFileManager.defaultManager removeItemAtURL:[self file:@"pending.json"] error:nil];
      [self schedule:0.5];
    } else {
      if ([error.domain isEqualToString:@"HTTPSQueue"] && (error.code == 404 || error.code == 409)) {
        [self save:pending name:@"unrecorded-result.json"];
        self.pending = nil;
        [NSFileManager.defaultManager removeItemAtURL:[self file:@"pending.json"] error:nil];
        [self schedule:5];
        return;
      }
      // Retry upload only, never the UI operation.
      [self schedule:15];
    }
  }];
}
- (void)localRequest:(NSString *)method path:(NSString *)path body:(NSDictionary *)body completion:(void (^)(NSDictionary *, NSError *))completion {
  if (![path hasPrefix:@"/"] || [path containsString:@".."] || [path containsString:@"?"]) { completion(nil,[NSError errorWithDomain:@"Queue" code:7 userInfo:nil]); return; }
  NSURL *url = [NSURL URLWithString:[@"http://127.0.0.1:8100" stringByAppendingString:path]];
  if (!url) { completion(nil,[NSError errorWithDomain:@"Queue" code:8 userInfo:nil]); return; }
  NSMutableURLRequest *request = [NSMutableURLRequest requestWithURL:(NSURL * _Nonnull)url];
  request.HTTPMethod = method;
  if (body) { [request setValue:@"application/json" forHTTPHeaderField:@"Content-Type"]; request.HTTPBody = [NSJSONSerialization dataWithJSONObject:body options:0 error:nil]; }
  [[self.local dataTaskWithRequest:request completionHandler:^(NSData *data, NSURLResponse *response, NSError *error) {
    NSDictionary *result = data && !error ? [NSJSONSerialization JSONObjectWithData:data options:0 error:&error] : nil;
    NSInteger status = [(NSHTTPURLResponse *)response statusCode];
    if (!error && (status < 200 || status >= 300)) error = [NSError errorWithDomain:@"WDA" code:status userInfo:@{NSLocalizedDescriptionKey:@"Device API rejected the operation; inspect before retrying"}];
    if ([result[@"value"] isKindOfClass:NSDictionary.class] && result[@"value"][@"error"]) {
      error = [NSError errorWithDomain:@"WDA" code:1 userInfo:@{NSLocalizedDescriptionKey:result[@"value"][@"message"] ?: @"Device operation failed"}];
      if ([result[@"value"][@"error"] isEqual:@"invalid session id"]) self.sessionID = nil;
    }
    completion(result,error);
  }] resume];
}
- (void)withSession:(void (^)(NSString *, NSError *))completion {
  if (self.sessionID) { completion(self.sessionID,nil); return; }
  [self localRequest:@"POST" path:@"/session" body:@{@"capabilities":@{@"alwaysMatch":@{@"platformName":@"iOS",@"waitForIdleTimeout":@0.5,@"animationCoolOffTimeout":@0.5}}} completion:^(NSDictionary *result, NSError *error) {
    NSString *sid = result[@"sessionId"];
    if (!sid && [result[@"value"] isKindOfClass:NSDictionary.class]) sid = result[@"value"][@"sessionId"];
    if (!error && !sid) error = [NSError errorWithDomain:@"WDA" code:2 userInfo:@{NSLocalizedDescriptionKey:@"Device session unavailable"}];
    self.sessionID = sid;
    completion(sid,error);
  }];
}
- (NSDictionary *)screenshotResult:(NSString *)base64 {
  if (![base64 isKindOfClass:NSString.class]) return nil;
  NSData *imageData = [[NSData alloc] initWithBase64EncodedString:base64 options:0];
  if (!imageData) return nil;
  UIImage *image = [UIImage imageWithData:(NSData * _Nonnull)imageData];
  if (!image) return nil;
  CGFloat scale = UIScreen.mainScreen.scale;
  CGSize size = CGSizeMake(image.size.width/scale,image.size.height/scale);
  UIGraphicsImageRendererFormat *format = [UIGraphicsImageRendererFormat defaultFormat]; format.scale = 1;
  UIGraphicsImageRenderer *renderer = [[UIGraphicsImageRenderer alloc] initWithSize:size format:format];
  UIImage *small = [renderer imageWithActions:^(UIGraphicsImageRendererContext *context) { [image drawInRect:(CGRect){CGPointZero,size}]; }];
  NSData *jpeg = UIImageJPEGRepresentation(small,0.65);
  if (jpeg.length > 500000) jpeg = UIImageJPEGRepresentation(small,0.35);
  if (!jpeg || jpeg.length > 500000) return nil;
  return @{@"mime_type":@"image/jpeg",@"image_base64":[jpeg base64EncodedStringWithOptions:0],@"width":@(size.width),@"height":@(size.height),@"coordinate_units":@"points; image pixels match device points"};
}
- (NSArray *)sequenceActions:(NSDictionary *)args duration:(double *)duration error:(NSError **)error {
  NSArray *steps = args[@"steps"];
  id captureValue = args[@"capture_delay_ms"];
  double captureDelay = [captureValue isKindOfClass:NSNumber.class] ? [captureValue doubleValue] : 0;
  BOOL valid = [steps isKindOfClass:NSArray.class] && steps.count > 0 && steps.count <= 12;
  valid = valid && (!captureValue || [captureValue isKindOfClass:NSNumber.class]);
  valid = valid && isfinite(captureDelay) && captureDelay >= 0 && captureDelay <= 2000 && floor(captureDelay) == captureDelay;
  NSMutableArray *sources = [NSMutableArray new];
  double milliseconds = 0;
  NSSet *topKeys = [NSSet setWithArray:@[@"steps",@"capture_delay_ms"]];
  for (NSString *key in args) if (![topKeys containsObject:key]) valid = NO;
  // Validate the complete plan before constructing a single touch event record.
  for (id object in (valid ? steps : @[])) {
    if (![object isKindOfClass:NSDictionary.class]) { valid = NO; break; }
    NSDictionary *step = object, *values = step[@"args"];
    NSString *kind = step[@"action"];
    if (![values isKindOfClass:NSDictionary.class] || step.count != 2) { valid = NO; break; }
    if ([kind isEqual:@"wait"]) {
      NSNumber *wait = values[@"duration_ms"];
      if (values.count != 1 || ![wait isKindOfClass:NSNumber.class] || !isfinite(wait.doubleValue) || wait.doubleValue < 0 || wait.doubleValue > 2000 || floor(wait.doubleValue) != wait.doubleValue) { valid = NO; break; }
      milliseconds += wait.doubleValue;
      continue;
    }
    BOOL tap = [kind isEqual:@"tap"], swipe = [kind isEqual:@"swipe"];
    if (!tap && !swipe) { valid = NO; break; }
    NSArray *coordinates = tap ? @[@"x",@"y"] : @[@"from_x",@"from_y",@"to_x",@"to_y"];
    NSMutableSet *allowed = [NSMutableSet setWithArray:coordinates];
    if (swipe) [allowed addObject:@"duration"];
    for (NSString *key in values) if (![allowed containsObject:key]) valid = NO;
    for (NSString *key in coordinates) {
      NSNumber *value = values[key];
      if (![value isKindOfClass:NSNumber.class] || !isfinite(value.doubleValue) || value.doubleValue < 0 || value.doubleValue > 3000) valid = NO;
    }
    id motionValue = values[@"duration"];
    double motion = [motionValue isKindOfClass:NSNumber.class] ? [motionValue doubleValue] : 0.25;
    if (motionValue && ![motionValue isKindOfClass:NSNumber.class]) valid = NO;
    if (swipe && (!isfinite(motion) || motion < 0.05 || motion > 5)) valid = NO;
    if (!valid) break;
    // Separate non-overlapping pointer paths prevent a later move from being
    // appended to a touch path that has already lifted. All paths still belong
    // to the same synthesized event and share this local millisecond schedule.
    NSMutableArray *items = [NSMutableArray new];
    if (milliseconds > 0) [items addObject:@{@"type":@"pause",@"duration":@(milliseconds)}];
    [items addObject:@{@"type":@"pointerMove",@"origin":@"viewport",@"duration":@0,@"x":values[tap ? @"x" : @"from_x"] ?: @0,@"y":values[tap ? @"y" : @"from_y"] ?: @0}];
    [items addObject:@{@"type":@"pointerDown",@"button":@0}];
    [items addObject:@{@"type":@"pause",@"duration":tap ? @40 : @50}];
    if (swipe) [items addObject:@{@"type":@"pointerMove",@"origin":@"viewport",@"duration":@(motion*1000),@"x":values[@"to_x"] ?: @0,@"y":values[@"to_y"] ?: @0}];
    [items addObject:@{@"type":@"pointerUp",@"button":@0}];
    [sources addObject:@{@"type":@"pointer",@"id":[NSString stringWithFormat:@"local-finger-%lu",(unsigned long)sources.count],@"parameters":@{@"pointerType":@"touch"},@"actions":items}];
    milliseconds += tap ? 40 : 50 + motion*1000;
  }
  if (!valid || milliseconds + captureDelay > 8000) {
    if (error) *error = [NSError errorWithDomain:@"Queue" code:9 userInfo:@{NSLocalizedDescriptionKey:@"Invalid or unbounded local sequence; nothing executed"}];
    return nil;
  }
  if (duration) *duration = milliseconds;
  return sources;
}
- (void)executeSequenceSteps:(NSArray *)steps index:(NSUInteger)index session:(NSString *)sid trace:(NSMutableArray *)trace completion:(void (^)(NSError *))completion {
  if (index >= steps.count) { completion(nil); return; }
  NSDictionary *step = steps[index];
  NSString *kind = step[@"action"];
  if ([kind isEqual:@"wait"]) {
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW,(int64_t)([step[@"args"][@"duration_ms"] doubleValue]*NSEC_PER_MSEC)),dispatch_get_main_queue(),^{
      [self executeSequenceSteps:steps index:index+1 session:sid trace:trace completion:completion];
    });
    return;
  }
  NSTimeInterval began = NSDate.date.timeIntervalSince1970*1000;
  void (^done)(NSDictionary *, NSError *) = ^(NSDictionary *result, NSError *error) {
    [trace addObject:@{@"index":@(index),@"action":kind ?: @"",@"started_at_ms":@(began),@"finished_at_ms":@(NSDate.date.timeIntervalSince1970*1000)}];
    if (error) { completion(error); return; }
    [self executeSequenceSteps:steps index:index+1 session:sid trace:trace completion:completion];
  };
  if ([kind isEqual:@"tap"]) {
    [self localRequest:@"POST" path:[NSString stringWithFormat:@"/session/%@/wda/tap",sid] body:step[@"args"] completion:done];
  } else {
    NSArray *actions = [self sequenceActions:@{@"steps":@[step]} duration:NULL error:NULL];
    [self localRequest:@"POST" path:[NSString stringWithFormat:@"/session/%@/actions",sid] body:@{@"actions":actions ?: @[]} completion:done];
  }
}
- (void)executeSequence:(NSDictionary *)args completion:(void (^)(NSDictionary *, NSError *))completion {
  NSError *validationError;
  double plannedDuration = 0;
  NSArray *actions = [self sequenceActions:args duration:&plannedDuration error:&validationError];
  if (!actions) { completion(nil,validationError); return; }
  [self withSession:^(NSString *sid, NSError *sessionError) {
    if (sessionError) { completion(nil,sessionError); return; }
    NSString *settingsPath = [NSString stringWithFormat:@"/session/%@/appium/settings",sid];
    [self localRequest:@"GET" path:settingsPath body:nil completion:^(NSDictionary *current, NSError *settingsError) {
      if (settingsError) { completion(nil,settingsError); return; }
      NSDictionary *old = @{@"waitForIdleTimeout":current[@"value"][@"waitForIdleTimeout"] ?: @0.5,@"animationCoolOffTimeout":current[@"value"][@"animationCoolOffTimeout"] ?: @0.5};
      [self localRequest:@"POST" path:settingsPath body:@{@"settings":@{@"waitForIdleTimeout":@0,@"animationCoolOffTimeout":@0}} completion:^(NSDictionary *set, NSError *setError) {
        if (setError) {
          [self localRequest:@"POST" path:settingsPath body:@{@"settings":old} completion:^(NSDictionary *restored, NSError *restoreError) { completion(nil,setError); }];
          return;
        }
        NSTimeInterval started = NSDate.date.timeIntervalSince1970*1000;
        NSMutableArray *trace = [NSMutableArray new];
        // Keep all control on the device. Separate local events allow UIKit to
        // commit each newly revealed control, without a cloud or model round trip.
        [self executeSequenceSteps:args[@"steps"] index:0 session:sid trace:trace completion:^(NSError *inputError) {
          NSTimeInterval finished = NSDate.date.timeIntervalSince1970*1000;
          dispatch_after(dispatch_time(DISPATCH_TIME_NOW,(int64_t)([args[@"capture_delay_ms"] doubleValue]*NSEC_PER_MSEC)),dispatch_get_main_queue(),^{
            [self execute:@{@"action":@"screenshot",@"args":@{}} completion:^(NSDictionary *image, NSError *imageError) {
              NSMutableDictionary *output = [NSMutableDictionary dictionaryWithDictionary:image ?: @{}];
              output[@"sequence"] = @{@"step_count":@([args[@"steps"] count]),@"planned_input_ms":@(plannedDuration),@"input_started_at_ms":@(started),@"input_finished_at_ms":@(finished),@"captured_at_ms":@(NSDate.date.timeIntervalSince1970*1000),@"device_local":@YES,@"step_timings":trace};
              [self localRequest:@"POST" path:settingsPath body:@{@"settings":old} completion:^(NSDictionary *restored, NSError *restoreError) {
                NSError *error = inputError ?: imageError ?: restoreError;
                if (error) output[@"error"] = @"Local sequence may have partially executed. Inspect the returned state; do not replay automatically.";
                completion(output,error);
              }];
            }];
          });
        }];
      }];
    }];
  }];
}
- (void)execute:(NSDictionary *)payload completion:(void (^)(NSDictionary *, NSError *))completion {
  NSString *action = payload[@"action"];
  NSDictionary *args = [payload[@"args"] isKindOfClass:NSDictionary.class] ? payload[@"args"] : @{};
  NSSet *allowed = [NSSet setWithArray:@[@"status",@"screenshot",@"source",@"home",@"launch",@"tap",@"swipe",@"type",@"foreground",@"sequence"]];
  if (![allowed containsObject:action]) { completion(nil,[NSError errorWithDomain:@"Queue" code:3 userInfo:@{NSLocalizedDescriptionKey:@"Unsupported operation"}]); return; }
  if ([action isEqual:@"sequence"]) { [self executeSequence:args completion:completion]; return; }
  if ([action isEqual:@"status"] || [action isEqual:@"home"] || [action isEqual:@"foreground"]) {
    NSString *path = [action isEqual:@"status"] ? @"/status" : [action isEqual:@"home"] ? @"/wda/homescreen" : @"/wda/activeAppInfo";
    [self localRequest:[action isEqual:@"home"] ? @"POST" : @"GET" path:path body:[action isEqual:@"home"] ? @{} : nil completion:completion]; return;
  }
  [self withSession:^(NSString *sid, NSError *error) {
    if (error) { completion(nil,error); return; }
    NSString *prefix = [NSString stringWithFormat:@"/session/%@",sid];
    NSString *suffix = nil, *method = @"POST"; NSDictionary *body = nil;
    if ([action isEqual:@"screenshot"]) { suffix=@"/screenshot"; method=@"GET"; }
    else if ([action isEqual:@"source"]) { suffix=@"/source"; method=@"GET"; }
    else if ([action isEqual:@"launch"] && [args[@"bundle_id"] isKindOfClass:NSString.class]) { suffix=@"/wda/apps/launch"; body=@{@"bundleId":args[@"bundle_id"] ?: @""}; }
    else if ([action isEqual:@"tap"] && [args[@"x"] isKindOfClass:NSNumber.class] && [args[@"y"] isKindOfClass:NSNumber.class]) { suffix=@"/wda/tap"; body=@{@"x":args[@"x"] ?: @0,@"y":args[@"y"] ?: @0}; }
    else if ([action isEqual:@"swipe"] && args[@"from_x"] && args[@"from_y"] && args[@"to_x"] && args[@"to_y"]) { suffix=@"/wda/dragfromtoforduration"; body=@{@"fromX":args[@"from_x"] ?: @0,@"fromY":args[@"from_y"] ?: @0,@"toX":args[@"to_x"] ?: @0,@"toY":args[@"to_y"] ?: @0,@"duration":args[@"duration"] ?: @0.5}; }
    else if ([action isEqual:@"type"] && [args[@"text"] isKindOfClass:NSString.class] && [args[@"text"] length]<=4096) { suffix=@"/wda/keys"; body=@{@"value":@[args[@"text"] ?: @""]}; }
    if (!suffix) { completion(nil,[NSError errorWithDomain:@"Queue" code:4 userInfo:@{NSLocalizedDescriptionKey:@"Invalid operation arguments"}]); return; }
    [self localRequest:method path:[prefix stringByAppendingString:suffix] body:body completion:^(NSDictionary *result, NSError *operationError) {
      if (!operationError && [action isEqual:@"screenshot"]) {
        NSDictionary *image = [self screenshotResult:result[@"value"]];
        if (!image) { completion(nil,[NSError errorWithDomain:@"Queue" code:5 userInfo:@{NSLocalizedDescriptionKey:@"Screenshot conversion failed"}]); return; }
        completion(image,nil); return;
      }
      if (!operationError && [action isEqual:@"source"] && [result[@"value"] isKindOfClass:NSString.class] && [result[@"value"] length]>200000) result=@{@"value":[result[@"value"] substringToIndex:200000] ?: @"",@"truncated":@YES};
      completion(result,operationError);
    }];
  }];
}
@end
