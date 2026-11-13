#import <React/RCTBridgeModule.h>
#import <React/RCTUtils.h>
#import <AVFoundation/AVFoundation.h>
#import <ImageIO/ImageIO.h>
#import <UIKit/UIKit.h>
#import <UniformTypeIdentifiers/UniformTypeIdentifiers.h>
#import <Vision/Vision.h>
#import <libtesseract/libtesseract.h>
#include <math.h>
#include <string.h>

@interface BabelMedia : NSObject <RCTBridgeModule, UIDocumentPickerDelegate>
@property(nonatomic, copy) RCTPromiseResolveBlock resolve;
@property(nonatomic, copy) RCTPromiseRejectBlock reject;
@property(nonatomic, copy) NSString *operation;
@property(nonatomic, copy) NSString *language;
@end

static NSError *MediaError(NSString *message) {
  return [NSError errorWithDomain:@"BabelMedia" code:1 userInfo:@{NSLocalizedDescriptionKey: message}];
}

static void Put16(uint8_t *buffer, uint16_t value) {
  buffer[0] = value & 255;
  buffer[1] = value >> 8;
}

static void Put32(uint8_t *buffer, uint32_t value) {
  Put16(buffer, value & 65535);
  Put16(buffer + 2, value >> 16);
}

static NSString *DecodeRecording(NSURL *url, NSError **error) {
  AVURLAsset *asset = [AVURLAsset URLAssetWithURL:url options:nil];
  double duration = CMTimeGetSeconds(asset.duration);
  if (!isfinite(duration) || duration <= 0 || duration > 600) {
    *error = MediaError(@"Choose a readable recording up to 10 minutes.");
    return nil;
  }
  AVAssetTrack *track = [asset tracksWithMediaType:AVMediaTypeAudio].firstObject;
  if (!track) {
    *error = MediaError(@"The recording has no audio track.");
    return nil;
  }
  AVAssetReader *reader = [[AVAssetReader alloc] initWithAsset:asset error:error];
  if (!reader) return nil;
  AVAssetReaderTrackOutput *audio = [[AVAssetReaderTrackOutput alloc] initWithTrack:track outputSettings:@{
    AVFormatIDKey: @(kAudioFormatLinearPCM), AVSampleRateKey: @16000,
    AVNumberOfChannelsKey: @1, AVLinearPCMBitDepthKey: @16,
    AVLinearPCMIsFloatKey: @NO, AVLinearPCMIsBigEndianKey: @NO,
    AVLinearPCMIsNonInterleaved: @NO
  }];
  if (![reader canAddOutput:audio]) {
    *error = MediaError(@"This audio format cannot be decoded.");
    return nil;
  }
  [reader addOutput:audio];
  if (![reader startReading]) {
    *error = reader.error ?: MediaError(@"Could not decode the recording.");
    return nil;
  }
  NSString *path = [NSTemporaryDirectory() stringByAppendingPathComponent:
    [NSString stringWithFormat:@"babel-%@.wav", NSUUID.UUID.UUIDString]];
  if (![[NSFileManager defaultManager] createFileAtPath:path contents:[NSMutableData dataWithLength:44] attributes:nil]) {
    *error = MediaError(@"Could not create a temporary recording.");
    [reader cancelReading];
    return nil;
  }
  NSFileHandle *file = [NSFileHandle fileHandleForWritingAtPath:path];
  uint32_t size = 0;
  BOOL valid = file != nil;
  @try {
    [file seekToEndOfFile];
    CMSampleBufferRef sample;
    while (valid && (sample = [audio copyNextSampleBuffer])) {
      CMBlockBufferRef buffer = CMSampleBufferGetDataBuffer(sample);
      size_t length = buffer ? CMBlockBufferGetDataLength(buffer) : 0;
      const AudioStreamBasicDescription *format =
        CMAudioFormatDescriptionGetStreamBasicDescription(CMSampleBufferGetFormatDescription(sample));
      valid = format && format->mSampleRate == 16000 && format->mChannelsPerFrame == 1 &&
        format->mBitsPerChannel == 16 && size + length <= 19200000;
      NSMutableData *pcm = valid ? [NSMutableData dataWithLength:length] : nil;
      if (valid && length) {
        valid = CMBlockBufferCopyDataBytes(buffer, 0, length, pcm.mutableBytes) == noErr;
      }
      CFRelease(sample);
      if (valid && length) {
        [file writeData:pcm];
        size += length;
      }
    }
    valid = valid && size > 0 && reader.status == AVAssetReaderStatusCompleted;
    if (valid) {
      uint8_t header[44] = {0};
      memcpy(header, "RIFF", 4);
      Put32(header + 4, size + 36);
      memcpy(header + 8, "WAVEfmt ", 8);
      Put32(header + 16, 16);
      Put16(header + 20, 1);
      Put16(header + 22, 1);
      Put32(header + 24, 16000);
      Put32(header + 28, 32000);
      Put16(header + 32, 2);
      Put16(header + 34, 16);
      memcpy(header + 36, "data", 4);
      Put32(header + 40, size);
      [file seekToFileOffset:0];
      [file writeData:[NSData dataWithBytes:header length:44]];
    }
  } @catch (NSException *exception) {
    valid = NO;
  } @finally {
    [file closeFile];
    [reader cancelReading];
  }
  if (!valid) {
    [[NSFileManager defaultManager] removeItemAtPath:path error:nil];
    *error = reader.error ?: MediaError(@"Could not convert this recording to speech audio.");
    return nil;
  }
  return path;
}

static NSString *RecogniseWithVision(CGImageRef image, NSString *language) {
  NSString *tag = @{@"eng": @"en", @"urd": @"ur", @"ara": @"ar", @"pus": @"ps",
    @"chi_sim": @"zh-Hans", @"chi_tra": @"zh-Hant"}[language];
  VNRecognizeTextRequest *request = [VNRecognizeTextRequest new];
  request.recognitionLevel = VNRequestTextRecognitionLevelAccurate;
  NSArray<NSString *> *supported = [request supportedRecognitionLanguagesAndReturnError:nil];
  NSString *selected = nil;
  for (NSString *entry in supported) {
    if ([entry isEqualToString:tag] || [entry hasPrefix:[tag stringByAppendingString:@"-"]]) {
      selected = entry;
      break;
    }
  }
  if (!selected) {
    return nil;
  }
  request.recognitionLanguages = @[selected];
  request.usesLanguageCorrection = ![language hasPrefix:@"chi_"];
  VNImageRequestHandler *handler = [[VNImageRequestHandler alloc] initWithCGImage:image options:@{}];
  BOOL success = [handler performRequests:@[request] error:nil];
  if (!success) return nil;
  NSMutableArray<NSString *> *lines = [NSMutableArray new];
  for (VNRecognizedTextObservation *observation in request.results) {
    VNRecognizedText *candidate = [observation topCandidates:1].firstObject;
    if (candidate.string.length) [lines addObject:candidate.string];
  }
  NSString *text = [lines componentsJoinedByString:@"\n"];
  if ([language hasPrefix:@"chi_"] &&
      [text rangeOfString:@"\\p{Han}" options:NSRegularExpressionSearch].location == NSNotFound) {
    return nil;
  }
  return text;
}

static NSString *RecogniseWithTesseract(CGImageRef image, NSString *language, NSError **error) {
  NSString *model = [NSBundle.mainBundle pathForResource:language ofType:@"traineddata" inDirectory:@"tessdata"];
  if (!model) {
    *error = MediaError(@"The offline photo recognition pack is missing. Install a build with the photo models.");
    return nil;
  }
  TessBaseAPI *engine = TessBaseAPICreate();
  if (!engine) {
    *error = MediaError(@"Could not initialise photo recognition.");
    return nil;
  }
  NSString *result = nil;
  @try {
    NSString *dataDirectory = model.stringByDeletingLastPathComponent;
    if (TessBaseAPIInit3(engine, dataDirectory.fileSystemRepresentation, language.UTF8String) != 0) {
      *error = MediaError(@"Could not load the offline photo recognition model.");
      return nil;
    }
    NSData *png = UIImagePNGRepresentation([UIImage imageWithCGImage:image]);
    PIX *pixels = png.length ? pixReadMem(png.bytes, png.length) : NULL;
    if (!pixels) {
      *error = MediaError(@"Could not prepare the photo for recognition.");
      return nil;
    }
    TessBaseAPISetImage2(engine, pixels);
    char *text = TessBaseAPIGetUTF8Text(engine);
    if (text) {
      result = [NSString stringWithUTF8String:text];
      TessDeleteText(text);
    }
    pixDestroy(&pixels);
    if (!result) *error = MediaError(@"Could not recognise text in the photo.");
  } @finally {
    TessBaseAPIDelete(engine);
  }
  return result;
}

static NSString *RecognisePhoto(NSURL *url, NSString *language, NSError **error) {
  if (![@[@"eng", @"urd", @"ara", @"pus", @"chi_sim", @"chi_tra"] containsObject:language]) {
    *error = MediaError(@"Choose a supported photo language.");
    return nil;
  }
  CGImageSourceRef source = CGImageSourceCreateWithURL((__bridge CFURLRef)url, NULL);
  if (!source) {
    *error = MediaError(@"Choose a readable photo.");
    return nil;
  }
  CGImageRef image = CGImageSourceCreateThumbnailAtIndex(source, 0, (__bridge CFDictionaryRef)@{
    (__bridge NSString *)kCGImageSourceCreateThumbnailFromImageAlways: @YES,
    (__bridge NSString *)kCGImageSourceCreateThumbnailWithTransform: @YES,
    (__bridge NSString *)kCGImageSourceThumbnailMaxPixelSize: @3200
  });
  CFRelease(source);
  if (!image) {
    *error = MediaError(@"Could not decode the photo.");
    return nil;
  }
  NSString *result = RecogniseWithVision(image, language);
  if (![result stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceAndNewlineCharacterSet].length) {
    result = RecogniseWithTesseract(image, language, error);
  }
  CGImageRelease(image);
  return result;
}

@implementation BabelMedia
RCT_EXPORT_MODULE()
+ (BOOL)requiresMainQueueSetup { return NO; }

- (void)pick:(NSArray<UTType *> *)types operation:(NSString *)operation language:(NSString *)language
    resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject {
  dispatch_async(dispatch_get_main_queue(), ^{
    UIViewController *presenter = RCTPresentedViewController();
    if (self.resolve || !presenter) {
      reject(@"PICKER_BUSY", @"Close the open picker and return to BabelTalk.", nil);
      return;
    }
    self.resolve = resolve;
    self.reject = reject;
    self.operation = operation;
    self.language = language;
    UIDocumentPickerViewController *picker = [[UIDocumentPickerViewController alloc]
      initForOpeningContentTypes:types asCopy:NO];
    picker.delegate = self;
    [presenter presentViewController:picker animated:YES completion:nil];
  });
}

RCT_EXPORT_METHOD(pickText:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject) {
  [self pick:@[UTTypePlainText] operation:@"text" language:@"" resolve:resolve reject:reject];
}
RCT_EXPORT_METHOD(pickPhoto:(NSString *)code resolver:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject) {
  [self pick:@[UTTypeImage] operation:@"photo" language:code resolve:resolve reject:reject];
}
RCT_EXPORT_METHOD(pickAudio:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject) {
  [self pick:@[UTTypeAudio, UTTypeMovie] operation:@"audio" language:@"" resolve:resolve reject:reject];
}

- (void)documentPickerWasCancelled:(UIDocumentPickerViewController *)controller {
  if (self.resolve) self.resolve(nil);
  self.resolve = nil;
  self.reject = nil;
}
- (void)documentPicker:(UIDocumentPickerViewController *)controller didPickDocumentsAtURLs:(NSArray<NSURL *> *)urls {
  NSURL *url = urls.firstObject;
  RCTPromiseResolveBlock resolve = self.resolve;
  RCTPromiseRejectBlock reject = self.reject;
  NSString *operation = self.operation;
  NSString *language = self.language;
  self.resolve = nil;
  self.reject = nil;
  if (!resolve || !reject) return;
  if (!url) { resolve(nil); return; }
  dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^{
    BOOL scope = [url startAccessingSecurityScopedResource];
    NSError *error = nil;
    NSString *result = nil;
    @try {
      if ([operation isEqualToString:@"photo"]) {
        result = RecognisePhoto(url, language, &error);
      } else if ([operation isEqualToString:@"audio"]) {
        result = DecodeRecording(url, &error);
      } else {
        NSNumber *size = nil;
        [url getResourceValue:&size forKey:NSURLFileSizeKey error:&error];
        if (size && size.unsignedLongLongValue <= 262144) {
          result = [NSString stringWithContentsOfURL:url encoding:NSUTF8StringEncoding error:&error];
          if ([result hasPrefix:@"\uFEFF"]) result = [result substringFromIndex:1];
        } else {
          error = MediaError(@"Choose a UTF-8 text file up to 256 KB.");
        }
      }
    } @finally {
      if (scope) [url stopAccessingSecurityScopedResource];
    }
    if (result) resolve(result);
    else reject(@"MEDIA_IMPORT", error.localizedDescription ?: @"Could not read the selected file.", error);
  });
}
@end
