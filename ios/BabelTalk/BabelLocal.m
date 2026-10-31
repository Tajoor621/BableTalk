#import <React/RCTBridgeModule.h>
#import <React/RCTUtils.h>
#import <UIKit/UIKit.h>
#import <AVFoundation/AVFoundation.h>
#import <MLKitTranslate/MLKitTranslate.h>
#import <MLKitCommon/MLKitCommon.h>

@interface BabelLocal : NSObject <RCTBridgeModule, AVSpeechSynthesizerDelegate>
@property(nonatomic,strong) NSMutableDictionary<NSString *, MLKTranslator *> *translators;
@property(nonatomic,strong) AVSpeechSynthesizer *speech;
@property(nonatomic,strong) AVSpeechUtterance *activeUtterance;
@property(nonatomic,copy) RCTPromiseResolveBlock pendingResolve;
@property(nonatomic,copy) RCTPromiseRejectBlock pendingReject;
@property(nonatomic,assign) BOOL sessionActive;
@property(nonatomic,assign) BOOL privatePlayback;
@property(nonatomic,copy) NSString *previousCategory;
@property(nonatomic,copy) NSString *previousMode;
@property(nonatomic,assign) AVAudioSessionCategoryOptions previousOptions;
@end
@implementation BabelLocal
RCT_EXPORT_MODULE();
+ (BOOL)requiresMainQueueSetup { return YES; }
- (dispatch_queue_t)methodQueue { return dispatch_get_main_queue(); }
- (instancetype)init { if (self = [super init]) { _translators = [NSMutableDictionary new]; [[NSNotificationCenter defaultCenter] addObserver:self selector:@selector(routeChanged:) name:AVAudioSessionRouteChangeNotification object:nil]; } return self; }
- (BOOL)valid:(NSString *)code { return [@[@"en", @"ur", @"ar"] containsObject:code]; }
- (MLKTranslator *)translator:(NSString *)a target:(NSString *)b {
  NSString *key = [NSString stringWithFormat:@"%@:%@", a, b];
  if (!self.translators[key]) {
    MLKTranslatorOptions *options = [[MLKTranslatorOptions alloc] initWithSourceLanguage:a targetLanguage:b];
    self.translators[key] = [MLKTranslator translatorWithOptions:options];
  }
  return self.translators[key];
}
RCT_EXPORT_METHOD(setSessionActive:(BOOL)active resolver:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject) { self.sessionActive = active; resolve(@YES); }
RCT_EXPORT_METHOD(preparePair:(NSString *)a target:(NSString *)b resolver:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject) {
  if (self.sessionActive || ![self valid:a] || ![self valid:b] || [a isEqualToString:b]) { reject(@"PAIR", @"End the session and select a supported pair", nil); return; }
  MLKModelDownloadConditions *conditions = [[MLKModelDownloadConditions alloc] initWithAllowsCellularAccess:NO allowsBackgroundDownloading:NO];
  [[self translator:a target:b] downloadModelIfNeededWithConditions:conditions completion:^(NSError *error) {
    if (error) reject(@"MODEL_DOWNLOAD", error.localizedDescription, error); else resolve(@YES);
  }];
}
RCT_EXPORT_METHOD(pairReady:(NSString *)a target:(NSString *)b resolver:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject) {
  if (![self valid:a] || ![self valid:b]) { resolve(@NO); return; }
  if ([a isEqualToString:b]) { resolve(@YES); return; }
  NSMutableSet *languages = [NSMutableSet new];
  for (MLKTranslateRemoteModel *model in [MLKModelManager modelManager].downloadedTranslateModels) [languages addObject:model.language];
  resolve(@(([a isEqualToString:@"en"] || [languages containsObject:a]) && ([b isEqualToString:@"en"] || [languages containsObject:b])));
}
RCT_EXPORT_METHOD(translate:(NSString *)text source:(NSString *)a target:(NSString *)b resolver:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject) {
  if (![self valid:a] || ![self valid:b] || text.length > 8000) { reject(@"PAIR", @"Unsupported pair or turn too long", nil); return; }
  if ([a isEqualToString:b]) { resolve(text); return; }
  // No model downloads in the inference path.
  [[self translator:a target:b] translateText:text completion:^(NSString *result, NSError *error) {
    if (error || !result) reject(@"TRANSLATION", @"Offline translation failed. Prepare this pair in Models first.", error); else resolve(result);
  }];
}
RCT_EXPORT_METHOD(initSpeech:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject) {
  if (!self.speech) { self.speech = [AVSpeechSynthesizer new]; self.speech.delegate = self; }
  resolve(@YES);
}
RCT_EXPORT_METHOD(offlineVoices:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject) {
  NSMutableArray *voices = [NSMutableArray new];
  for (AVSpeechSynthesisVoice *voice in [AVSpeechSynthesisVoice speechVoices]) {
    [voices addObject:@{@"language": [[voice.language componentsSeparatedByString:@"-"] firstObject], @"name": voice.identifier}];
  }
  resolve(voices);
}
- (void)routeChanged:(NSNotification *)note {
  if (!self.privatePlayback || !self.pendingResolve) return;
  BOOL privateOutput = NO;
  for (AVAudioSessionPortDescription *port in AVAudioSession.sharedInstance.currentRoute.outputs) {
    if ([@[AVAudioSessionPortHeadphones,AVAudioSessionPortBluetoothA2DP,AVAudioSessionPortBluetoothHFP,AVAudioSessionPortBluetoothLE,AVAudioSessionPortUSBAudio] containsObject:port.portType]) privateOutput = YES;
  }
  if (!privateOutput) { [self.speech stopSpeakingAtBoundary:AVSpeechBoundaryImmediate]; [self finish:@"Headphone output changed. Playback stopped to protect privacy."]; }
}
- (void)restoreRoute {
  if (!self.previousCategory) return;
  AVAudioSession *audio = AVAudioSession.sharedInstance;
  [audio overrideOutputAudioPort:AVAudioSessionPortOverrideNone error:nil];
  [audio setCategory:self.previousCategory mode:self.previousMode options:self.previousOptions error:nil];
  self.previousCategory = nil;
}
- (void)finish:(NSString *)error {
  RCTPromiseResolveBlock resolve = self.pendingResolve;
  RCTPromiseRejectBlock reject = self.pendingReject;
  self.pendingResolve = nil; self.pendingReject = nil; self.privatePlayback = NO; self.activeUtterance = nil;
  [self restoreRoute];
  if (error) { if (reject) reject(@"TTS", error, nil); } else if (resolve) resolve(@YES);
}
RCT_EXPORT_METHOD(speak:(NSString *)text language:(NSString *)lang destination:(NSString *)destination resolver:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject) {
  if (!self.speech || self.pendingResolve || text.length > 3500 || ![@[@"speaker",@"headphones"] containsObject:destination]) { reject(@"TTS_BUSY", @"Prepare the voice engine and wait for playback to finish", nil); return; }
  AVSpeechSynthesisVoice *selected = nil;
  for (AVSpeechSynthesisVoice *voice in [AVSpeechSynthesisVoice speechVoices]) {
    if ([[[voice.language componentsSeparatedByString:@"-"] firstObject] isEqualToString:lang]) { selected = voice; break; }
  }
  if (!selected) { reject(@"VOICE_MISSING", @"Install a matching system voice in device Settings. Translated text is available.", nil); return; }
  AVAudioSession *audio = AVAudioSession.sharedInstance;
  self.previousCategory = audio.category; self.previousMode = audio.mode; self.previousOptions = audio.categoryOptions;
  NSError *error = nil;
  [audio setCategory:AVAudioSessionCategoryPlayAndRecord mode:AVAudioSessionModeDefault options:AVAudioSessionCategoryOptionAllowBluetooth | AVAudioSessionCategoryOptionAllowBluetoothA2DP error:&error];
  if (!error) [audio setActive:YES error:&error];
  if (!error) [audio overrideOutputAudioPort:[destination isEqualToString:@"speaker"] ? AVAudioSessionPortOverrideSpeaker : AVAudioSessionPortOverrideNone error:&error];
  if (!error && [destination isEqualToString:@"headphones"]) {
    BOOL headphones = NO;
    for (AVAudioSessionPortDescription *port in audio.currentRoute.outputs) {
      if ([@[AVAudioSessionPortHeadphones, AVAudioSessionPortBluetoothA2DP, AVAudioSessionPortBluetoothHFP, AVAudioSessionPortBluetoothLE, AVAudioSessionPortUSBAudio] containsObject:port.portType]) headphones = YES;
    }
    if (!headphones) { [self restoreRoute]; reject(@"AUDIO_ROUTE", @"Connect headphones or explicitly select phone speaker.", nil); return; }
  }
  if (error) { [self restoreRoute]; reject(@"AUDIO_ROUTE", error.localizedDescription, error); return; }
  AVSpeechUtterance *utterance = [[AVSpeechUtterance alloc] initWithString:text]; utterance.voice = selected; utterance.rate = AVSpeechUtteranceDefaultSpeechRate;
  self.privatePlayback = [destination isEqualToString:@"headphones"]; self.pendingResolve = resolve; self.pendingReject = reject;
  self.activeUtterance = utterance; [self.speech speakUtterance:utterance];
}
RCT_EXPORT_METHOD(stopSpeech:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject) {
  [self.speech stopSpeakingAtBoundary:AVSpeechBoundaryImmediate]; [self finish:@"Playback stopped"]; resolve(@YES);
}
- (void)speechSynthesizer:(AVSpeechSynthesizer *)synth didFinishSpeechUtterance:(AVSpeechUtterance *)utterance { if (utterance == self.activeUtterance) [self finish:nil]; }
- (void)speechSynthesizer:(AVSpeechSynthesizer *)synth didCancelSpeechUtterance:(AVSpeechUtterance *)utterance { if (utterance == self.activeUtterance) [self finish:@"Playback stopped"]; }
RCT_EXPORT_METHOD(exportTranscript:(NSString *)content format:(NSString *)format resolver:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject) {
  if (![@[@"json",@"txt"] containsObject:format]) { reject(@"EXPORT", @"Unsupported export format", nil); return; }
  UIViewController *presenter = RCTPresentedViewController();
  if (!presenter) { reject(@"EXPORT", @"Open BabelTalk to export", nil); return; }
  NSURL *url = [NSURL fileURLWithPath:[NSTemporaryDirectory() stringByAppendingPathComponent:[NSString stringWithFormat:@"BabelTalk-%@.%@", NSUUID.UUID.UUIDString, format]]];
  NSError *error = nil;
  if (![content writeToURL:url atomically:YES encoding:NSUTF8StringEncoding error:&error]) { reject(@"EXPORT", error.localizedDescription, error); return; }
  UIActivityViewController *sheet = [[UIActivityViewController alloc] initWithActivityItems:@[url] applicationActivities:nil];
  if (sheet.popoverPresentationController) { sheet.popoverPresentationController.sourceView = presenter.view; sheet.popoverPresentationController.sourceRect = CGRectMake(CGRectGetMidX(presenter.view.bounds),CGRectGetMidY(presenter.view.bounds),1,1); }
  sheet.completionWithItemsHandler = ^(UIActivityType type, BOOL completed, NSArray *items, NSError *failure) {
    [[NSFileManager defaultManager] removeItemAtURL:url error:nil];
    if (failure) reject(@"EXPORT", failure.localizedDescription, failure); else resolve(@(completed));
  };
  [presenter presentViewController:sheet animated:YES completion:nil];
}
- (void)invalidate { [[NSNotificationCenter defaultCenter] removeObserver:self]; [self.speech stopSpeakingAtBoundary:AVSpeechBoundaryImmediate]; [self finish:@"App closed"]; [self.translators removeAllObjects]; }
@end
