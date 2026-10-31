// These pinned legacy modules omit the namespace required by AGP 8+.
// Keep changes local to these two packages and fail if their layout changes.
const fs = require('fs');
const path = require('path');
for (const name of [
  '@fugood/react-native-audio-pcm-stream',
  'react-native-fs',
]) {
  const root = path.dirname(require.resolve(`${name}/package.json`));
  const gradle = path.join(root, 'android/build.gradle');
  const manifestPath = path.join(root, 'android/src/main/AndroidManifest.xml');
  let content = fs.readFileSync(gradle, 'utf8');
  let manifest = fs.readFileSync(manifestPath, 'utf8');
  const match = manifest.match(/package="([^"]+)"/);
  if (!content.includes('namespace ')) {
    if (!match || !content.includes('android {')) {
      throw new Error(`${name} layout changed. Review compatibility patch.`);
    }
    content = content.replace(
      'android {',
      `android {\n    namespace "${match[1]}"`,
    );
    fs.writeFileSync(gradle, content);
  }
  if (match) {
    manifest = manifest.replace(/\s+package="[^"]+"/, '');
    fs.writeFileSync(manifestPath, manifest);
  }
}

// Pinned ONNX bridge: Gradle 9 removed VersionNumber; never resolve a moving native runtime.
const ortRoot = path.dirname(
  require.resolve('onnxruntime-react-native/package.json'),
);
const ortGradle = path.join(ortRoot, 'android/build.gradle');
let ortBuild = fs.readFileSync(ortGradle, 'utf8');
ortBuild = ortBuild.replace(
  'VersionNumber.parse(REACT_NATIVE_VERSION) < VersionNumber.parse("0.71")',
  'REACT_NATIVE_MINOR_VERSION < 71',
);
ortBuild = ortBuild.replaceAll(
  'onnxruntime-android:latest.integration@aar',
  'onnxruntime-android:1.24.3@aar',
);
ortBuild = ortBuild
  .replace('  api "org.mockito:mockito-core:2.28.2"', '')
  .replace('  implementation "junit:junit:4.12"', '');
fs.writeFileSync(ortGradle, ortBuild);
// Process-lifetime opt-out must happen before the first ORT environment is created.
const envHeader = path.join(ortRoot, 'cpp/Env.h');
let envSource = fs.readFileSync(envHeader, 'utf8');
if (!envSource.includes('ORT_DISABLE_TELEMETRY')) {
  const marker = '    ortEnv_ = std::make_shared<Ort::Env>(logLevel, logid);';
  if (!envSource.includes(marker)) {
    throw new Error('ORT environment layout changed; review privacy patch.');
  }
  envSource = envSource.replace(
    '#include <algorithm>',
    '#include <algorithm>\n#include <cstdlib>',
  );
  envSource = envSource.replace(
    marker,
    '    ::setenv("ORT_DISABLE_TELEMETRY", "1", 1);\n' +
      marker +
      '\n    ortEnv_->DisableTelemetryEvents();',
  );
  fs.writeFileSync(envHeader, envSource);
}

// Capture is always from the phone mic for both explicit turns. A may use the phone
// mic while wearing headphones; B must never be accidentally captured at A's headset.
const pcmRoot = path.dirname(
  require.resolve('@fugood/react-native-audio-pcm-stream/package.json'),
);
const pcmJavaPath = path.join(
  pcmRoot,
  'android/src/main/java/com/imxiqi/rnliveaudiostream/RNLiveAudioStreamModule.java',
);
let pcmJava = fs.readFileSync(pcmJavaPath, 'utf8');
if (!pcmJava.includes('BABELTALK_PHONE_CAPTURE')) {
  if (
    !pcmJava.includes('public void stop()') ||
    !pcmJava.includes('recorder = new AudioRecord(')
  ) {
    throw new Error(
      'PCM capture layout changed; review phone-microphone patch.',
    );
  }
  pcmJava = pcmJava.replace(
    'import android.media.AudioFormat;',
    'import android.media.AudioFormat;\nimport android.media.AudioManager;\nimport android.media.AudioDeviceInfo;\nimport android.content.Context;',
  );
  pcmJava = pcmJava.replace(
    'private boolean isRecording;',
    'private volatile boolean isRecording; // BABELTALK_PHONE_CAPTURE\n    private Thread recordingThread;',
  );
  pcmJava = pcmJava.replace(
    'public void init(ReadableMap options, Promise promise) {',
    'public void init(ReadableMap options, Promise promise) {\n        if (recordingThread != null && recordingThread.isAlive()) { promise.reject("CAPTURE_BUSY", "Wait for microphone shutdown"); return; }\n        recordingThread = null;',
  );
  pcmJava = pcmJava.replace(
    `recorder = new AudioRecord(audioSource, sampleRateInHz, channelConfig, audioFormat, recordingBufferSize);`.trim(),
    'recorder = new AudioRecord(audioSource, sampleRateInHz, channelConfig, audioFormat, recordingBufferSize);',
  );
  pcmJava = pcmJava.replace(
    `promise.resolve(null);`.trim(),
    `AudioManager manager = (AudioManager) reactContext.getSystemService(Context.AUDIO_SERVICE);
            AudioDeviceInfo phone = null;
            for (AudioDeviceInfo input : manager.getDevices(AudioManager.GET_DEVICES_INPUTS)) {
                if (input.getType() == AudioDeviceInfo.TYPE_BUILTIN_MIC) { phone = input; break; }
            }
            if (phone == null || !recorder.setPreferredDevice(phone)) {
                recorder.release(); recorder = null;
                promise.reject("MIC_ROUTE", "The phone microphone is unavailable"); return;
            }
            promise.resolve(null);`,
  );
  pcmJava = pcmJava.replace(
    'promise.reject("AudioRecord initialization failed");\n            recorder = null;',
    'promise.reject("CAPTURE_INIT", "AudioRecord initialization failed");\n            recorder.release(); recorder = null;',
  );
  pcmJava = pcmJava.replace(
    'recorder.startRecording();',
    'try { recorder.startRecording(); } catch (Exception e) { isRecording = false; recorder.release(); recorder = null; return; }',
  );
  pcmJava = pcmJava.replace(
    'Thread recordingThread = new Thread',
    'recordingThread = new Thread',
  );
  pcmJava = pcmJava.replace(
    'base64Data = Base64.encodeToString(buffer, Base64.NO_WRAP);',
    `AudioDeviceInfo actualInput = recorder.getRoutedDevice();
                            if (actualInput == null || actualInput.getType() != AudioDeviceInfo.TYPE_BUILTIN_MIC) {
                                throw new IllegalStateException("Phone microphone route was not honoured");
                            }
                            base64Data = Base64.encodeToString(buffer, 0, bytesRead, Base64.NO_WRAP);`,
  );
  pcmJava = pcmJava.replace(
    `public void stop() {
        isRecording = false;
    }`.trim(),
    `public void stop(Promise promise) {
        isRecording = false;
        final Thread previous = recordingThread;
        final AudioRecord current = recorder;
        if (current != null && previous == null) { current.release(); recorder = null; }
        else if (current != null) { try { current.stop(); } catch (Exception ignored) {} }
        new Thread(() -> {
            try {
                if (previous != null) previous.join(3000);
                if (previous != null && previous.isAlive()) { promise.reject("CAPTURE_STOP", "Microphone did not stop in time"); }
                else { promise.resolve(null); }
            } catch (InterruptedException e) { Thread.currentThread().interrupt(); promise.reject("CAPTURE_STOP", e); }
        }).start();
    }`,
  );
  pcmJava = pcmJava.replace(
    '        int recordingBufferSize = bufferSize * 3;',
    '        int recordingBufferSize = bufferSize * 3;\n        try {',
  );
  pcmJava = pcmJava.replace(
    '\n    }\n\n    @ReactMethod\n    public void start()',
    '\n        } catch (Exception error) {\n            if (recorder != null) { try { recorder.release(); } catch (Exception ignored) {} recorder = null; }\n            promise.reject("CAPTURE_INIT", error);\n        }\n    }\n\n    @ReactMethod\n    public void start()',
  );
  pcmJava = pcmJava.replace(
    '                } finally {\n                    recorder.release();',
    '                } finally {\n                    isRecording = false;\n                    recorder.release();',
  );
  pcmJava = pcmJava.replace(
    '    @Override\n    public String getName()',
    '    @ReactMethod public void addListener(String eventName) {}\n    @ReactMethod public void removeListeners(double count) {}\n\n    @Override\n    public String getName()',
  );
  fs.writeFileSync(pcmJavaPath, pcmJava);
  const pcmIosPath = path.join(pcmRoot, 'ios/RNLiveAudioStream.m');
  let pcmIos = fs.readFileSync(pcmIosPath, 'utf8');
  const queueMarker = '    _recordState.mIsRunning = true;';
  if (!pcmIos.includes(queueMarker)) {
    throw new Error(
      'iOS PCM capture layout changed; review phone-input patch.',
    );
  }
  pcmIos = pcmIos.replace(
    queueMarker,
    `    // BABELTALK_PHONE_CAPTURE: both turns use the phone mic; headphones are output only.
    if (![audioSession setActive:YES error:&error]) { RCTLog(@"[BabelTalk] Audio session could not activate"); return; }
    AVAudioSessionPortDescription *phone = nil;
    for (AVAudioSessionPortDescription *input in audioSession.availableInputs) {
        if ([input.portType isEqualToString:AVAudioSessionPortBuiltInMic]) { phone = input; break; }
    }
    if (!phone || ![audioSession setPreferredInput:phone error:&error]) {
        RCTLog(@"[BabelTalk] Phone microphone unavailable"); return;
    }
    _recordState.mIsRunning = true;`,
  );
  pcmIos = pcmIos.replace(
    'RCT_EXPORT_METHOD(stop) {',
    'RCT_EXPORT_METHOD(stop:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject) {',
  );
  pcmIos = pcmIos.replace(
    'AudioQueueDispose(_recordState.mQueue, true);\n    }\n}',
    'AudioQueueDispose(_recordState.mQueue, true);\n    }\n    resolve(@YES);\n}',
  );
  pcmIos = pcmIos.replace('    _recordState.mIsRunning = true;\n', '');
  pcmIos = pcmIos.replace(
    '    for (int i = 0; i < kNumberBuffers; i++) {',
    '    _recordState.mIsRunning = true;\n    for (int i = 0; i < kNumberBuffers; i++) {',
  );
  pcmIos = pcmIos.replace(
    '    short *samples = (short *) inBuffer->mAudioData;',
    `    BOOL phoneInput = NO;
    for (AVAudioSessionPortDescription *input in AVAudioSession.sharedInstance.currentRoute.inputs) {
        if ([input.portType isEqualToString:AVAudioSessionPortBuiltInMic]) { phoneInput = YES; break; }
    }
    if (!phoneInput) { AudioQueueEnqueueBuffer(inAQ, inBuffer, 0, NULL); return; }
    short *samples = (short *) inBuffer->mAudioData;`,
  );
  pcmIos = pcmIos.replace(
    'AudioQueueDispose(_recordState.mQueue, true);\n    }',
    'AudioQueueDispose(_recordState.mQueue, true);\n        _recordState.mQueue = NULL;\n    }',
  );
  pcmIos = pcmIos.replace(
    '    AudioQueueDispose(_recordState.mQueue, true);\n}\n\n@end',
    '    if (_recordState.mQueue != NULL) AudioQueueDispose(_recordState.mQueue, true);\n}\n\n@end',
  );
  fs.writeFileSync(pcmIosPath, pcmIos);
}
