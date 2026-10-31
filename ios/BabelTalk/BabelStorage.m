#import <React/RCTBridgeModule.h>
#import <sqlite3.h>
@interface BabelStorage : NSObject <RCTBridgeModule> { sqlite3 *_db; dispatch_queue_t _queue; }
@end
@implementation BabelStorage
RCT_EXPORT_MODULE();
+ (BOOL)requiresMainQueueSetup { return NO; }
- (dispatch_queue_t)methodQueue { if (!_queue) _queue = dispatch_queue_create("com.babeltalk.sqlite", DISPATCH_QUEUE_SERIAL); return _queue; }
- (BOOL)open:(NSError **)error {
  if (_db) return YES;
  NSURL *directory = [[[NSFileManager defaultManager] URLsForDirectory:NSApplicationSupportDirectory inDomains:NSUserDomainMask] firstObject];
  directory = [directory URLByAppendingPathComponent:@"BabelTalk" isDirectory:YES];
  if (![[NSFileManager defaultManager] createDirectoryAtURL:directory withIntermediateDirectories:YES attributes:@{NSFileProtectionKey:NSFileProtectionCompleteUntilFirstUserAuthentication} error:error]) return NO;
  [directory setResourceValue:@YES forKey:NSURLIsExcludedFromBackupKey error:nil];
  NSString *path = [[directory URLByAppendingPathComponent:@"babeltalk.sqlite"] path];
  if (sqlite3_open(path.UTF8String, &_db) != SQLITE_OK) { if (_db) sqlite3_close(_db); _db = NULL; return NO; }
  sqlite3_exec(_db, "PRAGMA foreign_keys=ON; PRAGMA secure_delete=ON;", NULL, NULL, NULL);
  return YES;
}
RCT_EXPORT_METHOD(execute:(NSString *)sql params:(NSArray *)params resolver:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject) {
  NSError *error = nil;
  if (![self open:&error]) { reject(@"SQLITE", @"Cannot open private session database", error); return; }
  sqlite3_stmt *statement = NULL;
  if (sqlite3_prepare_v2(_db, sql.UTF8String, -1, &statement, NULL) != SQLITE_OK) { reject(@"SQLITE", @(sqlite3_errmsg(_db)), nil); return; }
  if (sqlite3_bind_parameter_count(statement) != params.count) { sqlite3_finalize(statement); reject(@"SQLITE", @"Wrong parameter count", nil); return; }
  for (NSUInteger i = 0; i < params.count; i++) {
    id value = params[i]; int index = (int)i + 1;
    if (value == NSNull.null) sqlite3_bind_null(statement, index);
    else if ([value isKindOfClass:NSString.class]) sqlite3_bind_text(statement, index, [value UTF8String], -1, SQLITE_TRANSIENT);
    else if ([value isKindOfClass:NSNumber.class]) sqlite3_bind_double(statement, index, [value doubleValue]);
    else { sqlite3_finalize(statement); reject(@"SQLITE", @"SQL values must be scalar", nil); return; }
  }
  NSMutableArray *rows = [NSMutableArray new]; int result;
  while ((result = sqlite3_step(statement)) == SQLITE_ROW) {
    NSMutableDictionary *row = [NSMutableDictionary new];
    for (int i=0; i<sqlite3_column_count(statement); i++) {
      NSString *key = @(sqlite3_column_name(statement,i));
      switch (sqlite3_column_type(statement,i)) {
        case SQLITE_NULL: row[key]=NSNull.null; break;
        case SQLITE_INTEGER: row[key]=@(sqlite3_column_int64(statement,i)); break;
        case SQLITE_FLOAT: row[key]=@(sqlite3_column_double(statement,i)); break;
        default: row[key]=@((const char *)sqlite3_column_text(statement,i)); break;
      }
    }
    [rows addObject:row];
  }
  NSString *message = result == SQLITE_DONE ? nil : @(sqlite3_errmsg(_db));
  sqlite3_finalize(statement);
  if (message) reject(@"SQLITE", message, nil); else resolve(@{@"rows":rows});
}
- (void)invalidate { if (_db) { sqlite3_close(_db); _db=NULL; } }
@end
