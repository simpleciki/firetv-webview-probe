#!/usr/bin/env node
// One command: build both probe builds, install them side by side on the first connected device
// (a Fire TV Stick over adb, or an Android TV emulator), and open one.
//   npm run tv              opens "WebView Probe" (declares Amazon's voice permission)
//   npm run tv -- novoice   opens "WebView Probe (no voice permission)"
// Boots the first Android Virtual Device if nothing is connected. No dependencies.
'use strict';
const { execFileSync, execSync, spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const BASE_ID = 'io.github.simpleciki.firetvprobe';
const isWin = process.platform === 'win32';
const openNoVoice = process.argv.includes('novoice');

function fail(msg) { console.error('\n[probe] ' + msg); process.exit(1); }
function exists(p) { try { return !!p && fs.existsSync(p); } catch { return false; } }

function findSdk() {
  const fromProps = (() => {
    const f = path.join(ROOT, 'local.properties');
    if (!exists(f)) return null;
    const m = fs.readFileSync(f, 'utf8').match(/^sdk\.dir=(.+)$/m);
    return m ? m[1].trim().replace(/\\\\/g, '\\').replace(/\\:/g, ':') : null;
  })();
  const candidates = [
    process.env.ANDROID_HOME, process.env.ANDROID_SDK_ROOT, fromProps,
    isWin && path.join(process.env.LOCALAPPDATA || '', 'Android', 'Sdk'),
    process.platform === 'darwin' && path.join(os.homedir(), 'Library', 'Android', 'sdk'),
    path.join(os.homedir(), 'Android', 'Sdk'),
  ];
  return candidates.find((p) => exists(p && path.join(p, 'platform-tools')));
}

function ensureJava(env) {
  if (env.JAVA_HOME && exists(env.JAVA_HOME)) return;
  // Android Studio ships its own JDK, but a terminal does not see it.
  const jbr = [
    'C:\\Program Files\\Android\\Android Studio\\jbr',
    '/Applications/Android Studio.app/Contents/jbr/Contents/Home',
    '/opt/android-studio/jbr',
  ].find(exists);
  if (!jbr) fail('No Java found. Set JAVA_HOME, or install Android Studio (it bundles a JDK).');
  env.JAVA_HOME = jbr;
  console.log('[probe] JAVA_HOME -> ' + jbr);
}

function sleep(ms) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }

const sdk = findSdk();
if (!sdk) fail('Android SDK not found. Install Android Studio, or set ANDROID_HOME.');
const adb = path.join(sdk, 'platform-tools', isWin ? 'adb.exe' : 'adb');
const emulator = path.join(sdk, 'emulator', isWin ? 'emulator.exe' : 'emulator');
const run = (bin, args, opts = {}) => execFileSync(bin, args, { encoding: 'utf8', ...opts });
const devices = () => run(adb, ['devices']).split('\n').slice(1).filter((l) => /\tdevice$/.test(l.trim()));

if (devices().length === 0) {
  const avds = exists(emulator) ? run(emulator, ['-list-avds']).split(/\r?\n/).filter(Boolean) : [];
  if (avds.length === 0) fail('No device connected and no emulator found. Connect a Fire TV Stick (adb connect <ip>), or create a "Television (1080p)" AVD in Android Studio.');
  console.log('[probe] booting emulator ' + avds[0] + ' ...');
  spawn(emulator, ['-avd', avds[0]], { detached: true, stdio: 'ignore' }).unref();
  run(adb, ['wait-for-device']);
}
// "Booted" is not "ready": sys.boot_completed can read 1 while the package manager still
// answers nothing, and an install then fails with an empty reason.
const ready = () => {
  try {
    return run(adb, ['shell', 'getprop', 'sys.boot_completed']).trim() === '1'
      && run(adb, ['shell', 'pm', 'path', 'android']).includes('package:');
  } catch { return false; }
};
for (let i = 0; !ready(); i++) {
  if (i === 90) fail('The device is connected but its package manager never became ready. Restart it and run again.');
  if (i === 0) console.log('[probe] waiting for the device to be ready ...');
  sleep(2000);
}
console.log('[probe] device: ' + devices()[0].split('\t')[0]);

const env = { ...process.env };
ensureJava(env);
console.log('[probe] building both builds ...');
const gradlew = path.join(ROOT, isWin ? 'gradlew.bat' : 'gradlew');
execSync(`"${gradlew}" assembleDebug -q`, { cwd: ROOT, env, stdio: 'inherit' });
// Install with adb, not Gradle's installDebug: its device query can skip a working emulator.
for (const [flavor, suffix] of [['withVoicePermission', '.voice'], ['withoutVoicePermission', '.novoice']]) {
  const apk = path.join(ROOT, 'app', 'build', 'outputs', 'apk', flavor, 'debug', `app-${flavor}-debug.apk`);
  if (!exists(apk)) fail('Build finished but no APK at ' + apk);
  run(adb, ['install', '-r', apk], { stdio: 'inherit' });
  console.log('[probe] installed ' + BASE_ID + suffix);
}
const open = BASE_ID + (openNoVoice ? '.novoice' : '.voice');
run(adb, ['shell', 'am', 'start', '-n', `${open}/${BASE_ID}.ProbeActivity`]);
console.log('[probe] opened ' + open + '. OK to start, Back to exit.');
