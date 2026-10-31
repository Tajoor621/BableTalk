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
const ortRoot = path.dirname(require.resolve('onnxruntime-react-native/package.json'));
const ortGradle = path.join(ortRoot, 'android/build.gradle');
let ortBuild = fs.readFileSync(ortGradle, 'utf8');
ortBuild = ortBuild.replace('VersionNumber.parse(REACT_NATIVE_VERSION) < VersionNumber.parse("0.71")', 'REACT_NATIVE_MINOR_VERSION < 71');
ortBuild = ortBuild.replaceAll('onnxruntime-android:latest.integration@aar', 'onnxruntime-android:1.24.3@aar');
ortBuild = ortBuild.replace('  api "org.mockito:mockito-core:2.28.2"', '').replace('  implementation "junit:junit:4.12"', '');
fs.writeFileSync(ortGradle, ortBuild);
// Process-lifetime opt-out must happen before the first ORT environment is created.
const envHeader = path.join(ortRoot, 'cpp/Env.h');
let envSource = fs.readFileSync(envHeader, 'utf8');
if (!envSource.includes('ORT_DISABLE_TELEMETRY')) {
  const marker = '    ortEnv_ = std::make_shared<Ort::Env>(logLevel, logid);';
  if (!envSource.includes(marker)) { throw new Error('ORT environment layout changed; review privacy patch.'); }
  envSource = envSource.replace('#include <algorithm>', '#include <algorithm>\n#include <cstdlib>');
  envSource = envSource.replace(marker, '    ::setenv("ORT_DISABLE_TELEMETRY", "1", 1);\n' + marker + '\n    ortEnv_->DisableTelemetryEvents();');
  fs.writeFileSync(envHeader, envSource);
}
