// probe-core — the probe's steps, how each step's evidence is summarised, and the compact
// report that leaves the TV as a QR code. No DOM, no device: everything here runs in Node.
//
// The rule for every step: record what actually arrived, through which door, and never fill
// in what didn't. "Nothing arrived" is a result, not an error.
(function (root) {
  'use strict';

  const STEPS = [
    { id: 'dpad', kind: 'keys', title: 'Direction pad', prompt: 'Press ↑  ↓  ←  →  and then OK.',
      expect: ['up', 'down', 'left', 'right', 'select'], timeoutMs: 20000 },
    { id: 'transport', kind: 'keys', title: 'Media buttons', prompt: 'Press ⏯  then ⏪  then ⏩  (if your remote has them).',
      expect: ['playPause', 'rewind', 'fastForward'], timeoutMs: 20000 },
    { id: 'menu', kind: 'keys', title: 'Menu button', prompt: 'Press ☰ (Menu), if your remote has it.',
      expect: ['menu'], timeoutMs: 10000 },
    // Voice: the page tells the media session it is playing or paused before each phrase, so the
    // same phrase can be tried in both states ("pause" while already paused is the telling one).
    { id: 'voicePausePlaying', kind: 'voice', title: 'Voice: pause (while playing)', phrase: 'Alexa, pause', state: 'playing', timeoutMs: 30000 },
    { id: 'voicePausePaused', kind: 'voice', title: 'Voice: pause (already paused)', phrase: 'Alexa, pause', state: 'paused', timeoutMs: 30000 },
    { id: 'voicePlay', kind: 'voice', title: 'Voice: play', phrase: 'Alexa, play', state: 'paused', timeoutMs: 30000 },
    { id: 'voiceRewind', kind: 'voice', title: 'Voice: rewind', phrase: 'Alexa, rewind', state: 'playing', timeoutMs: 30000 },
    { id: 'voiceFastForward', kind: 'voice', title: 'Voice: fast forward', phrase: 'Alexa, fast forward', state: 'playing', timeoutMs: 30000 },
    // Video: the same clip, styled four ways. Whether it is visible only a person can say (the
    // video element reports "playing" either way), so the step asks, and also records what the
    // element itself reports.
    { id: 'videoPlain', kind: 'video', title: 'Video: plain', variant: 'plain' },
    { id: 'videoRounded', kind: 'video', title: 'Video: rounded corners', variant: 'rounded' },
    { id: 'videoHeldFade', kind: 'video', title: 'Video: page fade-in that stays applied', variant: 'held-fade' },
    { id: 'videoEndingFade', kind: 'video', title: 'Video: page fade-in that ends', variant: 'ending-fade' },
  ];

  // One letter per door, for the compact report.
  const DOOR = { dom: 'd', key: 'k', mediaButton: 'm', session: 's' };

  // keys step → { up: 'dk', menu: '' , ... }: which doors delivered each expected action.
  function summariseKeys(step, actions) {
    const out = {};
    for (const want of step.expect) {
      const doors = new Set(actions.filter((a) => a.action === want).map((a) => DOOR[a.source]));
      out[want] = ['d', 'k', 'm', 's'].filter((x) => doors.has(x)).join('');
    }
    return out;
  }

  // voice step → short tokens in arrival order, e.g. ['k85v', 'd:playPause'] or ['s:onPause'].
  //   k<code>[v]  activity key event (v = virtual device, deviceId -1)
  //   m<code>     media-button intent to the session
  //   s:<cb>      media-session callback (onSeekTo carries its delta in seconds: s:seek-10)
  //   d:<action>  DOM keydown in the page
  //   L:pause / L:resume  the activity was paused / resumed (e.g. by the voice overlay)
  //   t:<type>    Vega OS: the app shell's React Native TV event (t:playpause)
  //   d?<key>     DOM keydown with a key this probe has no name for (its raw `key`)
  //   v:<event>   the page's own <video> was paused / played / seeked by the system, not by the page
  //               (v:seek-10 = seeked 10 s back)
  function voiceToken(o) {
    if (o.kind === 'key') return 'k' + o.code + (o.deviceId === -1 ? 'v' : '');
    if (o.kind === 'tv') return o.keyAction == null || o.keyAction === 0 ? 't:' + o.type : null;
    if (o.kind === 'domOther') return 'd?' + o.key;
    if (o.kind === 'video') {
      if (o.event === 'seeked') return typeof o.delta === 'number' ? 'v:seek' + (o.delta > 0 ? '+' : '') + Math.round(o.delta) : 'v:seek';
      return 'v:' + o.event;
    }
    if (o.kind === 'mediaButton') return 'm' + o.code;
    if (o.kind === 'session') {
      if (o.callback === 'onSeekTo') {
        if (o.pos === 0) return 's:seek0';
        if (typeof o.anchor === 'number') { const s = Math.round((o.pos - o.anchor) / 1000); return 's:seek' + (s > 0 ? '+' : '') + s; }
        return 's:seek';
      }
      return 's:' + o.callback;
    }
    if (o.kind === 'dom') return 'd:' + o.action;
    if (o.kind === 'lifecycle') return o.event === 'onPause' ? 'L:pause' : 'L:resume';
    return null;
  }
  function summariseVoice(observations) {
    return observations.map(voiceToken).filter(Boolean);
  }
  // Does this observation mean Alexa has answered, so the step may wrap up? Lifecycle does not:
  // holding the microphone button opens the voice overlay, which pauses the app before a word is
  // said (Fire OS 8.1.8.2, 2026-10-01: the step ended mid-sentence because of this).
  function endsVoiceWait(o) {
    const t = voiceToken(o);
    return !!t && !t.startsWith('L:');
  }
  // How long to keep listening after this observation (each new one restarts the wait), or null
  // if it does not count as an answer. On Vega OS, holding the microphone button pauses the page's
  // own video before a word is said (4K Select, 2026-10-03: "rewind" and "fast forward" both ended
  // on that pause, before Alexa answered), so a pause alone waits long enough for the answer.
  const VOICE_SETTLE_MS = 3000;
  const VOICE_AFTER_VIDEO_PAUSE_MS = 10000;
  function voiceSettleMs(o) {
    if (!endsVoiceWait(o)) return null;
    return o.kind === 'video' && o.event === 'pause' ? VOICE_AFTER_VIDEO_PAUSE_MS : VOICE_SETTLE_MS;
  }

  // What a voice result means, in words, for the on-screen table. Only says what the tokens show.
  function describeVoice(tokens) {
    const skipped = tokens.includes('skipped');
    tokens = tokens.filter((x) => x !== 'skipped');
    if (tokens.length === 0) return skipped ? 'Skipped before anything arrived.' : 'Nothing reached the app.';
    if (tokens.every((t) => t.startsWith('L:'))) return 'Nothing from Alexa reached the app; it was only paused and resumed by the voice overlay.' + (skipped ? ' (Skipped.)' : '');
    const parts = [];
    if (tokens.some((t) => t.startsWith('s:'))) parts.push('media-session callback');
    if (tokens.some((t) => /^k\d+v$/.test(t))) parts.push('key event from a virtual device');
    else if (tokens.some((t) => /^k\d+$/.test(t))) parts.push('key event');
    if (tokens.some((t) => t.startsWith('t:'))) parts.push('app shell TV event');
    if (tokens.some((t) => t.startsWith('m'))) parts.push('media-button intent');
    if (tokens.some((t) => t.startsWith('d:') || t.startsWith('d?'))) parts.push('DOM keydown');
    if (tokens.some((t) => t.startsWith('v:'))) parts.push('the system acting on the page’s video directly');
    let s = 'Arrived as: ' + parts.join(' + ') + '.';
    if (tokens.includes('L:pause')) s += ' The app was paused while you spoke.';
    if (skipped) s += ' (Skipped.)';
    return s;
  }

  // video step → 'y' / 'n' / '-' (person: seen / not seen / skipped) + what the element reported:
  // p1 = not paused, aN = seconds the clock advanced in the check window, rN = readyState.
  function summariseVideo(answer, el) {
    const a = answer === 'seen' ? 'y' : answer === 'not-seen' ? 'n' : '-';
    if (!el) return a;
    return a + ' p' + (el.paused ? 0 : 1) + ' a' + Math.round(el.advancedS * 10) / 10 + ' r' + el.readyState;
  }

  // The whole report as a compact JSON string (fits a QR code a phone can read off a TV).
  // Nothing link-shaped goes inside the report itself (2026-10-01: a phone opened the WebView's own
  // https origin and showed "can't reach this page"), so the only link in the QR code is the one to
  // the report page. Origin becomes a short code; the WebView keeps only its version.
  function originCode(origin) {
    if (/^https:\/\/appassets\.androidplatform\.net$/.test(origin || '')) return 'appassets';
    if (!origin || origin === 'null' || origin.startsWith('file:')) return 'file';
    return 'other';
  }
  function webviewVersion(w) { return (w || '').replace(/^\S+\s+/, ''); }
  function deviceForReport(d) {
    if (!d) return null;
    // Vega OS shell: no Android fields; `mc` = whether this build's manifest declares the media-control block.
    if (d.shell === 'vega') return { sh: 'vega', m: d.model, f: d.os, w: webviewVersion(d.webview), px: d.displayPx, mc: d.mediaControl };
    return { m: d.model, f: d.fireOs, a: d.android, s: d.sdk, w: webviewVersion(d.webview), px: d.displayPx, vp: d.voicePermission };
  }
  function buildReport(env, results) {
    const r = {};
    for (const s of STEPS) if (results[s.id] !== undefined) r[s.id] = results[s.id];
    return JSON.stringify({
      v: 1,
      p: 'firetv-webview-probe',
      dev: deviceForReport(env.device),
      view: { w: env.innerWidth, h: env.innerHeight, dpr: env.devicePixelRatio },
      o: originCode(env.origin),
      r,
    });
  }

  // The QR code is a link to the probe's own report page with the report after the '#'. A browser
  // never sends that part to a server, so the report still goes nowhere unless the person shares it.
  // The fragment keeps JSON readable and short: structural characters are swapped for ones that are
  // legal in a URL fragment. A swap character that was really in the report is written as ~XX (our
  // own escape, in characters no browser rewrites), and everything else outside the safe set is
  // percent-encoded. So a browser or a camera app may percent-encode any part of the link on its
  // way (some turn ' into %27) and the report still reads back the same.
  const REPORT_PAGE = 'https://simpleciki.github.io/firetv-webview-probe/';
  const SWAP = { '"': "'", '{': '(', '}': ')', '[': '!', ']': '*', ' ': '_' };
  const UNSWAP = Object.fromEntries(Object.entries(SWAP).map(([a, b]) => [b, a]));
  function encodeFragment(text) {
    let out = '';
    for (const ch of text) {
      if (SWAP[ch]) out += SWAP[ch];
      else if (/[!'()*_~]/.test(ch)) out += '~' + ch.charCodeAt(0).toString(16).toUpperCase();
      else if (/[A-Za-z0-9\-.:,\/]/.test(ch)) out += ch;
      else out += encodeURIComponent(ch);
    }
    return out;
  }
  function decodeFragment(fragment) {
    const f = decodeURIComponent(String(fragment || '').replace(/^#/, ''));
    return f.replace(/~([0-9A-F]{2})|[\s\S]/g, (c, hex) => (hex ? String.fromCharCode(parseInt(hex, 16)) : UNSWAP[c] || c));
  }
  function reportLink(report) { return REPORT_PAGE + '#' + encodeFragment(report); }
  // A report read back from a link: null unless it is one of ours.
  function parseReport(fragment) {
    try {
      const r = JSON.parse(decodeFragment(fragment));
      return r && r.p === 'firetv-webview-probe' && r.v === 1 && r.r ? r : null;
    } catch (e) { return null; }
  }

  const api = { STEPS, DOOR, REPORT_PAGE, encodeFragment, decodeFragment, reportLink, parseReport, summariseKeys, voiceToken, summariseVoice, endsVoiceWait, voiceSettleMs, describeVoice, summariseVideo, buildReport };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.ProbeCore = api;
})(typeof window !== 'undefined' ? window : globalThis);
