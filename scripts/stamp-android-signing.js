/**
 * 给 Capacitor 生成的 android/app/build.gradle 写入固定 debug 签名配置。
 *
 * 背景：CI 里仅把 keystore 复制到 ~/.android/debug.keystore 不够，AGP 8.2.1
 * 在 validateSigningDebug 仍会现场生成一把新的 debug key。这里显式声明
 * signingConfigs.debug，确保 APK 真正用仓库内那把固定 keystore 签名。
 */
const fs = require('fs');
const path = require('path');

const gradle = path.join(__dirname, '..', 'android', 'app', 'build.gradle');
if (!fs.existsSync(gradle)) {
  throw new Error('找不到 android/app/build.gradle，请先执行 npx cap add android');
}

let source = fs.readFileSync(gradle, 'utf8');
const MARKER = '// SKFE fixed debug signing';
if (source.includes(MARKER)) {
  console.log('[signing] android/app/build.gradle 已写入固定 debug 签名配置');
  process.exit(0);
}

const anchor = '    buildTypes {';
if (!source.includes(anchor)) {
  throw new Error('android/app/build.gradle 里找不到 buildTypes 块');
}

const signingConfig = [
  '    ' + MARKER,
  '    signingConfigs {',
  '        debug {',
  "            storeFile file('../../native/android-debug.keystore')",
  "            storePassword 'android'",
  "            keyAlias 'androiddebugkey'",
  "            keyPassword 'android'",
  '        }',
  '    }',
  ''
].join('\n');

const debugType = [
  '        debug {',
  '            signingConfig signingConfigs.debug',
  '        }',
  ''
].join('\n');

source = source.replace(anchor, signingConfig + anchor + '\n' + debugType);
fs.writeFileSync(gradle, source, 'utf8');
console.log('[signing] 已写入固定 debug 签名配置');
