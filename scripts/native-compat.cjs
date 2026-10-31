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
