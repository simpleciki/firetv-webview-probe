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
  const link = Core.reportLink(report);   // what the QR code actually carries
  const q = qrcode(0, 'L'); q.addData(link, 'Byte'); q.make();
  assert.ok(q.getModuleCount() <= 125, `QR has ${q.getModuleCount()} modules for ${link.length} bytes (version ≤ 27 stays readable from a sofa)`);
  assert.equal(Core.decodeFragment(link.split('#')[1]), report, 'the report read back from the link is the report that went in');
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
    // The one address the app knows is its report page, and it only ever draws it into a QR code.
    const src = read('app', 'src', 'main', 'assets', f).replace(`const REPORT_PAGE = '${Core.REPORT_PAGE}';`, '');
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

test('the report itself holds nothing a phone camera would open as a link; the QR code holds exactly one, to the report page', () => {
  const env = { device: { model: 'AFTMA08C15', fireOs: 'Fire OS 8.1.8.2 (RS8182/3811)', android: '11', sdk: 30,
    webview: 'com.amazon.webview.chromium 148.amazon-webview-v148-7778-tv.7778.258.6', displayPx: '1920x1080', voicePermission: true },
    innerWidth: 960, innerHeight: 540, devicePixelRatio: 4, origin: 'https://appassets.androidplatform.net' };
  const report = Core.buildReport(env, {});
  assert.doesNotMatch(report, /:\/\/|www\.|androidplatform|com\.amazon/);
  const j = JSON.parse(report);
  assert.equal(j.o, 'appassets');
  assert.equal(j.dev.w, '148.amazon-webview-v148-7778-tv.7778.258.6');
  assert.equal(Core.buildReport({ ...env, origin: 'null' }, {}).includes('"o":"file"'), true);
  const link = Core.reportLink(report);
  assert.equal(link.match(/https?:/g).length, 1);
  assert.ok(link.startsWith(Core.REPORT_PAGE + '#'), 'the report rides after the #, the part a browser never sends');
  assert.match(read('app', 'src', 'main', 'assets', 'probe-ui.js'), /q\.addData\(reportLink\(report\), 'Byte'\)/);
});

// ---------- report link and report page ----------

test('any report survives the trip through a link, whatever characters a device reports', () => {
  const odd = JSON.stringify({ v: 1, p: 'firetv-webview-probe', dev: { m: "AFT (x)_y 'z' !* ~7E ~", f: 'Fire OS 8.1.8.2 (RS8182/3811)', w: '100% ü 电视 #?&=+' },
    r: { voicePlay: ['k85v', 'd:playPause', 's:seek+10', 'v:seek-10', 'd?Unidentified/179'], videoPlain: 'y p1 a2.3 r4' } });
  const fragment = Core.encodeFragment(odd);
  assert.match(fragment, /^[A-Za-z0-9\-._~:,\/'()!*%]+$/, 'only characters that are legal in a URL fragment');
  assert.equal(Core.decodeFragment(fragment), odd);
  assert.equal(Core.decodeFragment('#' + fragment), odd, 'location.hash arrives with its #');
  const mangled = fragment.replace(/'/g, '%27').replace(/\(/g, '%28').replace(/!/g, '%21').replace(/_/g, '%5F');
  assert.equal(Core.decodeFragment(mangled), odd, 'a browser that percent-encodes the link on the way changes nothing');
  assert.deepEqual(Core.parseReport('#' + fragment), JSON.parse(odd));
});

test('a link that is not a probe report is refused, not shown as one', () => {
  for (const bad of ['', '#', '#hello', '#' + Core.encodeFragment('{"v":1,"p":"something-else","r":{}}'),
    '#' + Core.encodeFragment('{"v":2,"p":"firetv-webview-probe","r":{}}'), '#%E0%A4%A', '#' + Core.encodeFragment('[1,2]')]) {
    assert.equal(Core.parseReport(bad), null, JSON.stringify(bad));
  }
});

test('the report page reads reports with the same code as the app: docs/probe-core.js is a byte-for-byte copy', () => {
  assert.equal(read('docs', 'probe-core.js'), read('app', 'src', 'main', 'assets', 'probe-core.js'), 'run `npm run page`');
});

test('the report page cannot send a report anywhere, and never treats one as HTML', () => {
  const html = read('docs', 'index.html'), js = read('docs', 'report.js');
  assert.match(html, /Content-Security-Policy" content="default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; img-src 'self'; connect-src 'none'/);
  const srcs = [...html.matchAll(/<(?:script|img|link)[^>]*(?:src|href)="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(srcs.sort(), ['logo.svg', 'probe-core.js', 'report.js'], 'only its own files');
  assert.doesNotMatch(js, /fetch\(|XMLHttpRequest|sendBeacon|WebSocket|EventSource|new Image|innerHTML|insertAdjacentHTML|document\.write|eval\(/);
  assert.doesNotMatch(html, /<script(?![^>]*src=)/, 'no inline script');
  assert.equal(new URL(Core.REPORT_PAGE).hostname, 'simpleciki.github.io');
});

test('the report page says what the TV said, and turns a report into a row for the device table', () => {
  const Page = require(path.join(ROOT, 'docs', 'report.js'));
  const env = { device: { model: 'AFTMA08C15', fireOs: 'Fire OS 8.1.8.2 (RS8182/3811)', android: '11', sdk: 30,
    webview: 'com.amazon.webview.chromium 148.0', displayPx: '1920x1080', voicePermission: true },
    innerWidth: 960, innerHeight: 540, devicePixelRatio: 4, origin: 'https://appassets.androidplatform.net' };
  const results = { dpad: { up: 'dk', down: 'dk', left: 'dk', right: 'dk', select: 'd' }, menu: { menu: '', skipped: true },
    voicePausePlaying: ['k85v', 'd:playPause'], voicePausePaused: [], videoRounded: 'n p1 a2.2 r4', videoHeldFade: 'y p1 a2.2 r4' };
  const report = Core.parseReport('#' + Core.reportLink(Core.buildReport(env, results)).split('#')[1]);
  const facts = Object.fromEntries(Page.deviceFacts(report));
  assert.equal(facts.Device, 'AFTMA08C15');
  assert.equal(facts.Display, '1920x1080 px · the page sees 960×540 CSS px · devicePixelRatio 4');
  assert.equal(facts['Voice permission'], 'declared in this build');
  const lines = Object.fromEntries(Page.stepLines(report));
  assert.equal(lines['Voice: pause (already paused)'], Core.describeVoice([]), 'same words as the TV');
  assert.equal(lines['Menu button'], 'menu: not received (skipped)');
  assert.ok(!('Media buttons' in lines), 'a step that was never run is not listed');
  assert.equal(lines['Video: rounded corners'], 'The person did NOT see it. The video element reported: playing, clock advanced 2.2 s, readyState 4. (n p1 a2.2 r4)',
    'the answer and what the element claimed, side by side: the element says "playing" either way');
  assert.equal(Page.videoWords('-'), 'Skipped.');
  const row = Page.markdownRow(report, '2026-10-04');
  assert.equal(row.split(' | ').length, 11, 'one cell per column of the README table');
  assert.match(row, /^\| AFTMA08C15 \| Fire OS 8\.1\.8\.2 \(RS8182\/3811\) · WebView 148\.0 \| 960×540, DPR 4 \| up `dk`, down `dk`, left `dk`, right `dk`, select `d` \| not measured \(step skipped\) \| not measured \(step skipped\) \|/);
  assert.match(row, /pause \(while playing\): `k85v` `d:playPause`; pause \(already paused\): nothing \| — \| \*\*not visible\*\* \| visible \| 2026-10-04 \|$/);
  const vega = { v: 1, p: 'firetv-webview-probe', dev: { sh: 'vega', f: 'Vega OS', w: '144.0', px: '1920x1080', mc: false }, view: { w: 1920, h: 1080, dpr: 1 }, o: 'file', r: { voicePlay: [] } };
  assert.match(Page.markdownRow(vega, '2026-10-04'), /\| — \| play: nothing \| not measured \| not measured \| 2026-10-04 \|$/, 'a build without the declaration fills the "without" column');
  assert.equal(Object.fromEntries(Page.deviceFacts(vega))['Media declaration'], 'not declared in this build');
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

test('both shells carry the same logo, and the Vega manifest points at it', () => {
  assert.ok(fs.existsSync(path.join(ROOT, 'docs', 'logo.svg')));
  for (const p of [['app', 'src', 'main', 'res', 'drawable-nodpi', 'icon.png'], ['vega', 'image', 'icon.png']]) {
    const b = fs.readFileSync(path.join(ROOT, ...p));
    assert.equal(b.readUInt32BE(16), 512, p.join('/') + ' is 512 px wide'); assert.equal(b.readUInt32BE(20), 512);
  }
  assert.match(read('vega', 'manifest.template.toml'), /^icon = "@image\/icon\.png"$/m);
  assert.match(read('scripts', 'vega.js'), /path\.join\(VEGA, 'image'\)/);
});

test('the README links to real reports, and each one opens as a report', () => {
  const links = [...read('README.md').matchAll(/\]\(<(https:\/\/simpleciki\.github\.io\/firetv-webview-probe\/#[^>]+)>\)/g)].map((m) => m[1]);
  assert.equal(links.length, 4);
  const reports = links.map((l) => Core.parseReport('#' + l.split('#')[1]));
  for (const r of reports) assert.ok(r && r.r && r.dev, 'a link in the README that the report page would refuse');
  assert.deepEqual(reports.map((r) => r.dev.sh || 'fireos'), ['vega', 'fireos', 'fireos', 'fireos']);
  assert.deepEqual(reports.map((r) => !!(r.dev.mc || r.dev.vp)), [true, true, true, false], 'with and without the voice declaration');
  // The same stick and OS build, three days apart: keys from a virtual device, then media-session callbacks.
  assert.ok(reports[1].r.voicePlay.every((t) => !t.startsWith('s:')) && reports[2].r.voicePlay.every((t) => t.startsWith('s:')));
  assert.equal(reports[1].dev.f, reports[2].dev.f);
});
