'use strict';
// Runs with Node's built-in test runner: `npm test`. No dependencies, no device.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const ASSETS = path.join(ROOT, 'app', 'src', 'main', 'assets');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');
const RA = require(path.join(ASSETS, 'remote-actions.js'));
const Core = require(path.join(ASSETS, 'probe-core.js'));
const qrcode = require(path.join(ASSETS, 'vendor', 'qrcode.min.js'));

// ---------- remote-actions ----------

test('DOM keys from a Fire TV remote get one name each', () => {
  const cases = { ArrowUp: 'up', ArrowLeft: 'left', Enter: 'select', MediaPlayPause: 'playPause',
    MediaRewind: 'rewind', MediaFastForward: 'fastForward', MediaTrackPrevious: 'previous', ContextMenu: 'menu' };
  for (const [key, action] of Object.entries(cases)) assert.deepEqual(RA.fromDomKey({ key }), { action, source: 'dom', key });
  assert.equal(RA.fromDomKey({ key: 'a' }), null, 'keys the module does not name are left alone');
});

test('native key codes get the same names; deviceId -1 is reported as virtual, not guessed as voice', () => {
  assert.deepEqual(RA.fromNative({ kind: 'key', code: 85, deviceId: -1 }), { action: 'playPause', source: 'key', code: 85, virtual: true });
  assert.deepEqual(RA.fromNative({ kind: 'key', code: 89, deviceId: 7 }), { action: 'rewind', source: 'key', code: 89, virtual: false });
  assert.equal(RA.fromNative({ kind: 'mediaButton', code: 127, deviceId: 3 }).action, 'pause');
  assert.equal(RA.fromNative({ kind: 'key', code: 999, deviceId: 1 }), null);
  assert.ok(!JSON.stringify(RA.fromNative({ kind: 'key', code: 85, deviceId: -1 })).includes('voice'));
});

test('session seeks read as direction against the reported position; a seek to 0 is restart', () => {
  const anchor = 3600000;
  assert.deepEqual(RA.fromNative({ kind: 'session', callback: 'onSeekTo', pos: anchor - 10000, anchor }), { action: 'seekBack', source: 'session', deltaMs: -10000 });
  assert.deepEqual(RA.fromNative({ kind: 'session', callback: 'onSeekTo', pos: anchor + 30000, anchor }), { action: 'seekForward', source: 'session', deltaMs: 30000 });
  assert.equal(RA.fromNative({ kind: 'session', callback: 'onSeekTo', pos: 0, anchor }).action, 'restart');
  assert.equal(RA.fromNative({ kind: 'session', callback: 'onSeekTo', pos: 5000 }).action, 'seek', 'no anchor: no invented direction');
  assert.equal(RA.fromNative({ kind: 'session', callback: 'onPause' }).action, 'pause');
  assert.equal(RA.fromNative({ kind: 'session', callback: 'onPlay' }).action, 'play');
});

test('one press through two doors is delivered once; two real presses are not merged', () => {
  let t = 0; const got = [];
  const r = RA.create({ onAction: (a) => got.push(a.source + ':' + a.action), now: () => t });
  r.handleNative({ kind: 'key', code: 85, deviceId: -1 }); t = 5;
  r.handleDom({ key: 'MediaPlayPause' });                    // same press, second door
  t = 400; r.handleDom({ key: 'MediaPlayPause' });           // a later, separate press
  t = 405; r.handleDom({ key: 'MediaPlayPause' });           // same door twice: two presses
  assert.deepEqual(got, ['key:playPause', 'dom:playPause', 'dom:playPause']);
});

// ---------- probe-core ----------

test('keys summary lists the doors each expected action came through, and nothing for what never came', () => {
  const step = Core.STEPS.find((s) => s.id === 'transport');
  const out = Core.summariseKeys(step, [
    { action: 'playPause', source: 'key' }, { action: 'playPause', source: 'dom' }, { action: 'rewind', source: 'dom' }]);
  assert.deepEqual(out, { playPause: 'dk', rewind: 'd', fastForward: '' });
});

test('voice tokens keep arrival order and name the door; an empty list says nothing arrived', () => {
  const t = Core.summariseVoice([
    { kind: 'lifecycle', event: 'onPause' },
    { kind: 'key', code: 85, deviceId: -1 },
    { kind: 'dom', action: 'playPause' },
    { kind: 'session', callback: 'onSeekTo', pos: 3590000, anchor: 3600000 },
    { kind: 'state', playing: true }]);
  assert.deepEqual(t, ['L:pause', 'k85v', 'd:playPause', 's:seek-10']);
  assert.match(Core.describeVoice(t), /media-session callback \+ key event from a virtual device \+ DOM keydown/);
  assert.match(Core.describeVoice(t), /paused while you spoke/);
  assert.equal(Core.describeVoice([]), 'Nothing reached the app.');
});

test('video result keeps the person’s answer apart from what the element reported', () => {
  assert.equal(Core.summariseVideo('not-seen', { paused: false, readyState: 4, advancedS: 2.46 }), 'n p1 a2.5 r4');
  assert.equal(Core.summariseVideo('seen', { paused: false, readyState: 4, advancedS: 2.5 }), 'y p1 a2.5 r4');
  assert.equal(Core.summariseVideo('skipped', null), '-');
});

test('a worst-case report still fits a QR code a phone can read off the TV', () => {
  const env = { device: { model: 'AFTXXXXXXXXXX', fireOs: 'Fire OS 8.1.6.0 (PS8160/0000)', android: '11', sdk: 30,
    webview: 'com.amazon.webview.chromium 142.0.7444.000', displayPx: '1920x1080', voicePermission: true },
    innerWidth: 960, innerHeight: 540, devicePixelRatio: 2, origin: 'https://appassets.androidplatform.net' };
  const results = {};
  const noisy = ['L:pause', 'k85v', 'd:playPause', 'm85', 's:onPause', 's:seek-10', 'L:resume', 'k88v', 'd:previous'];
  for (const s of Core.STEPS) {
    if (s.kind === 'keys') results[s.id] = Object.fromEntries(s.expect.map((w) => [w, 'dkms']));
    else if (s.kind === 'voice') results[s.id] = noisy;
    else results[s.id] = 'n p1 a2.5 r4';
  }
  const report = Core.buildReport(env, results);
  assert.ok(report.length < 1500, `report is ${report.length} bytes`);
  const q = qrcode(0, 'L'); q.addData(report, 'Byte'); q.make();
  assert.ok(q.getModuleCount() <= 117, `QR has ${q.getModuleCount()} modules (version ≤ 25 stays readable from a sofa)`);
  assert.deepEqual(JSON.parse(report).r.dpad, results.dpad);
});

test('every step has an id the report can carry, and the UI runs every kind', () => {
  const ui = read('app', 'src', 'main', 'assets', 'probe-ui.js');
  const ids = Core.STEPS.map((s) => s.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const kind of new Set(Core.STEPS.map((s) => s.kind))) assert.ok(ui.includes(`s.kind === '${kind}'`), `UI handles ${kind}`);
});

test('a step never records the press that opened it, and Back (the skip key) is not voice evidence', () => {
  // Found on the emulator: the OK that started the run arrived through its second door after
  // step 1 began, so step 1 counted it and ended before the person pressed OK.
  const ui = read('app', 'src', 'main', 'assets', 'probe-ui.js');
  const guards = ui.match(/if \(performance\.now\(\) - started < STEP_GUARD_MS\) return;/g) || [];
  assert.equal(guards.length, 2, 'keys and voice steps both ignore their first moments');
  assert.match(ui, /if \(o\.kind === 'key' && o\.code === 4\) return;/);
});

test('"skipped" and "nothing arrived" never read the same', () => {
  // Found on the emulator: voice steps skipped with Back were reported as "Nothing reached the app."
  assert.equal(Core.describeVoice(['skipped']), 'Skipped before anything arrived.');
  assert.equal(Core.describeVoice([]), 'Nothing reached the app.');
  assert.match(Core.describeVoice(['k85v', 'skipped']), /key event from a virtual device.*\(Skipped\.\)/);
  const ui = read('app', 'src', 'main', 'assets', 'probe-ui.js');
  assert.match(ui, /if \(o\.kind === 'back'\) \{ if \(settled\(\)\) finish\(true\); return; \}/);
  assert.match(ui, /if \(skipped === true\) r\.skipped = 1;/);
  assert.match(ui, /if \(skipped === true\) r\.push\('skipped'\);/);
  assert.match(ui, /r\.skipped \? ' \(skipped\)' : ''/);
});

// ---------- the tests the probe is for: keep them honest ----------

test('the video variants are exactly the styles under test', () => {
  const css = read('app', 'src', 'main', 'assets', 'probe.css');
  assert.match(css, /\.stage video\.rounded \{ border-radius: 24px; \}/);
  assert.match(css, /body\.fade-held \{ animation: probe-fade \.35s both; \}/, 'held fade stays applied (fill-mode both)');
  assert.match(css, /body\.fade-ending \{ animation: probe-fade \.35s backwards; \}/, 'control: fade that ends');
  assert.doesNotMatch(css.replace(/\.stage video\.rounded \{[^}]*\}/, ''), /video[^{]*\{[^}]*border-radius/, 'no other video rule is rounded');
});

test('the two builds differ only in Amazon’s voice permission', () => {
  const perm = 'com.amazon.permission.media.session.voicecommandcontrol';
  assert.ok(!read('app', 'src', 'main', 'AndroidManifest.xml').includes(`android:name="${perm}"`), 'main manifest leaves it out');
  assert.ok(read('app', 'src', 'withVoicePermission', 'AndroidManifest.xml').includes(`<uses-permission android:name="${perm}" />`));
  const gradle = read('app', 'build.gradle.kts');
  assert.match(gradle, /create\("withVoicePermission"\)/);
  assert.match(gradle, /create\("withoutVoicePermission"\)/);
});

test('the native shell offers seek, reports a fixed anchor, and never turns its session off mid-app', () => {
  const kt = read('app', 'src', 'main', 'java', 'io', 'github', 'simpleciki', 'firetvprobe', 'ProbeActivity.kt');
  assert.match(kt, /PlaybackState\.ACTION_SEEK_TO/);
  assert.match(kt, /override fun onSeekTo\(pos: Long\) = cb\("onSeekTo", pos\)/);
  assert.match(kt, /put\("anchor", ANCHOR_MS\)/);
  assert.doesNotMatch(kt, /isActive = false/, 'a session switched off in onPause would miss the command being spoken');
  assert.match(kt, /return super\.dispatchKeyEvent\(event\)/, 'keys continue to the WebView so DOM delivery is observable');
});

test('the probe sends nothing anywhere', () => {
  assert.ok(!read('app', 'src', 'main', 'AndroidManifest.xml').includes('android.permission.INTERNET'));
  for (const f of fs.readdirSync(ASSETS).filter((f) => /\.(js|html|css)$/.test(f))) {
    const src = read('app', 'src', 'main', 'assets', f);
    assert.doesNotMatch(src, /\bfetch\(|XMLHttpRequest|WebSocket|sendBeacon|https?:\/\//, `${f} makes no network call and links nowhere`);
  }
});

test('nothing from any other product is in this repository', () => {
  const files = [];
  (function walk(d) {
    for (const f of fs.readdirSync(d, { withFileTypes: true })) {
      if (['.git', '.gradle', 'build', 'node_modules', '.idea', 'vendor'].includes(f.name)) continue;
      const p = path.join(d, f.name);
      if (f.isDirectory()) walk(p); else if (/\.(js|kt|kts|xml|css|html|md|json|sh|toml|properties)$/.test(f.name)) files.push(p);
    }
  })(ROOT);
  const banned = /jumponion|onion.?skin|skat/i;
  for (const p of files) {
    if (p === __filename) continue;
    assert.doesNotMatch(fs.readFileSync(p, 'utf8'), banned, path.relative(ROOT, p));
  }
});

test('a voice step waits through the overlay: lifecycle alone never ends it, Alexa evidence does', () => {
  assert.equal(Core.endsVoiceWait({ kind: 'lifecycle', event: 'onPause' }), false);
  assert.equal(Core.endsVoiceWait({ kind: 'lifecycle', event: 'onResume' }), false);
  assert.equal(Core.endsVoiceWait({ kind: 'key', code: 85, deviceId: -1 }), true);
  assert.equal(Core.endsVoiceWait({ kind: 'session', callback: 'onPause' }), true, 'the session callback named onPause is Alexa, not lifecycle');
  assert.equal(Core.endsVoiceWait({ kind: 'state' }), false);
  for (const s of Core.STEPS.filter((x) => x.kind === 'voice')) assert.ok(s.timeoutMs >= 30000, s.id + ' leaves time to speak');
});

test('the voice step only starts its wrap-up timer on Alexa evidence, and restarts it on each new piece', () => {
  assert.match(read('app', 'src', 'main', 'assets', 'probe-ui.js'),
    /const ms = voiceSettleMs\(o\);\s*if \(ms != null\) \{ clearTimeout\(settle\); settle = setTimeout\(finish, ms\); \}/);
  assert.equal(Core.voiceSettleMs({ kind: 'lifecycle', event: 'onPause' }), null);
  assert.equal(Core.voiceSettleMs({ kind: 'key', code: 85, deviceId: -1 }), 3000);
});

test('on Vega a pause of the page video alone waits for the answer: the microphone button pauses it first', () => {
  assert.equal(Core.voiceSettleMs({ kind: 'video', event: 'pause' }), 10000);
  assert.equal(Core.voiceSettleMs({ kind: 'video', event: 'play' }), 3000);
  assert.equal(Core.voiceSettleMs({ kind: 'video', event: 'seeked', delta: -10 }), 3000);
});

test('a voice step that only saw the overlay says so in words, not "Arrived as: ."', () => {
  const d = Core.describeVoice(['L:pause', 'L:resume']);
  assert.match(d, /Nothing from Alexa reached the app/);
  assert.doesNotMatch(d, /Arrived as: \./);
});

test('every Back handler waits until the screen has settled, so one press skips one step', () => {
  const ui = read('app', 'src', 'main', 'assets', 'probe-ui.js');
  assert.match(ui, /function show\(\.\.\.nodes\) \{ screen\.replaceChildren\(\.\.\.nodes\); shownAt = performance\.now\(\); \}/);
  const backSites = ui.match(/(kind === 'back'|a === 'back')[^;\n]*/g);
  assert.ok(backSites.length >= 6, 'found ' + backSites.length + ' Back handlers');
  for (const site of backSites) assert.match(site, /settled\(\)/, 'unguarded Back: ' + site);
});

test('the QR report holds nothing a phone camera would open as a link', () => {
  const env = { device: { model: 'AFTMA08C15', fireOs: 'Fire OS 8.1.8.2 (RS8182/3811)', android: '11', sdk: 30,
    webview: 'com.amazon.webview.chromium 148.amazon-webview-v148-7778-tv.7778.258.6', displayPx: '1920x1080', voicePermission: true },
    innerWidth: 960, innerHeight: 540, devicePixelRatio: 4, origin: 'https://appassets.androidplatform.net' };
  const report = Core.buildReport(env, {});
  assert.doesNotMatch(report, /:\/\/|www\.|androidplatform|com\.amazon/);
  const j = JSON.parse(report);
  assert.equal(j.o, 'appassets');
  assert.equal(j.dev.w, '148.amazon-webview-v148-7778-tv.7778.258.6');
  assert.equal(Core.buildReport({ ...env, origin: 'null' }, {}).includes('"o":"file"'), true);
});

// ---------- Vega OS shell ----------

test('Vega TV events get the same action names; only the press counts, not the release', () => {
  assert.deepEqual(RA.fromNative({ kind: 'tv', type: 'playpause', keyAction: 0 }), { action: 'playPause', source: 'key', type: 'playpause' });
  assert.equal(RA.fromNative({ kind: 'tv', type: 'forward', keyAction: 0 }).action, 'fastForward');
  assert.equal(RA.fromNative({ kind: 'tv', type: 'playpause', keyAction: 1 }), null, 'key up is not a second press');
  assert.equal(RA.fromNative({ kind: 'tv', type: 'num_5', keyAction: 0 }), null);
});

test('Vega voice tokens: shell TV event, unnamed DOM key, and the system acting on the page video', () => {
  const tokens = Core.summariseVoice([
    { kind: 'tv', type: 'playpause', keyAction: 0 }, { kind: 'tv', type: 'playpause', keyAction: 1 },
    { kind: 'domOther', key: 'Unidentified/179' },
    { kind: 'video', event: 'pause' }, { kind: 'video', event: 'seeked', delta: -10.2 },
  ]);
  assert.deepEqual(tokens, ['t:playpause', 'd?Unidentified/179', 'v:pause', 'v:seek-10']);
  const words = Core.describeVoice(tokens);
  assert.match(words, /app shell TV event/); assert.match(words, /DOM keydown/); assert.match(words, /page’s video directly/);
  assert.ok(Core.endsVoiceWait({ kind: 'video', event: 'pause' }), 'the system pausing the video is Alexa evidence');
});

test('a Vega report says which shell and which manifest it came from, with no Android fields', () => {
  const env = { device: { shell: 'vega', model: 'AFTCA', os: 'Vega OS 1.2', webview: 'Chrome 132.0.0.0', displayPx: '1920x1080', mediaControl: true },
    innerWidth: 960, innerHeight: 540, devicePixelRatio: 2, origin: 'null' };
  const r = JSON.parse(Core.buildReport(env, {}));
  assert.deepEqual(r.dev, { sh: 'vega', m: 'AFTCA', f: 'Vega OS 1.2', w: '132.0.0.0', px: '1920x1080', mc: true });
  assert.equal(r.o, 'file');
});

test('the two Vega builds differ only in the media-control declaration', () => {
  const src = read('scripts', 'vega.js');
  assert.match(src, /mediaControl: true/); assert.match(src, /mediaControl: false/);
  assert.match(src, /IMediaPlaybackServer/);
  const app = read('vega', 'src', 'App.tsx');
  assert.match(app, /allowsDefaultMediaControl\b/, 'both builds leave the WebView media control at its default (on)');
  assert.doesNotMatch(app, /allowsDefaultMediaControl=\{false\}/);
});

test('voice steps on Vega use a clip with an audio track that never loops', () => {
  const ui = read('app', 'src', 'main', 'assets', 'probe-ui.js');
  assert.match(ui, /v\.src = 'voice-clip\.mp4'/);
  assert.doesNotMatch(ui.slice(ui.indexOf('function pageMedia'), ui.indexOf('function voiceStep')), /loop = true/);
  assert.ok(fs.existsSync(path.join(ASSETS, 'voice-clip.mp4')));
});

test('a seek of the page video is measured from where it was when the seek began, not from its own timeupdate', () => {
  const ui = read('app', 'src', 'main', 'assets', 'probe-ui.js');
  const pm = ui.slice(ui.indexOf('function pageMedia'), ui.indexOf('function voiceStep'));
  assert.match(pm, /addEventListener\('seeking', \(\) => \{ if \(seekFrom === null\) seekFrom = lastT; \}\)/);
  assert.match(pm, /v\.currentTime - from/);
  assert.doesNotMatch(pm, /v\.currentTime - lastT/);
});
