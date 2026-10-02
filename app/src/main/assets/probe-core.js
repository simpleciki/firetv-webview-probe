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
  function voiceToken(o) {
    if (o.kind === 'key') return 'k' + o.code + (o.deviceId === -1 ? 'v' : '');
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
    if (tokens.some((t) => t.startsWith('m'))) parts.push('media-button intent');
    if (tokens.some((t) => t.startsWith('d:'))) parts.push('DOM keydown');
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
  // The report is plain text in a QR code. Phone cameras open anything that looks like a link, so
  // nothing link-shaped goes in (2026-10-01: a phone opened the WebView's own https origin and
  // showed "can't reach this page"). Origin becomes a short code; the WebView keeps only its version.
  function originCode(origin) {
    if (/^https:\/\/appassets\.androidplatform\.net$/.test(origin || '')) return 'appassets';
    if (!origin || origin === 'null' || origin.startsWith('file:')) return 'file';
    return 'other';
  }
  function webviewVersion(w) { return (w || '').replace(/^\S+\s+/, ''); }
  function buildReport(env, results) {
    const r = {};
    for (const s of STEPS) if (results[s.id] !== undefined) r[s.id] = results[s.id];
    return JSON.stringify({
      v: 1,
      p: 'firetv-webview-probe',
      dev: env.device ? {
        m: env.device.model, f: env.device.fireOs, a: env.device.android, s: env.device.sdk,
        w: webviewVersion(env.device.webview), px: env.device.displayPx, vp: env.device.voicePermission,
      } : null,
      view: { w: env.innerWidth, h: env.innerHeight, dpr: env.devicePixelRatio },
      o: originCode(env.origin),
      r,
    });
  }

  const api = { STEPS, DOOR, summariseKeys, voiceToken, summariseVoice, endsVoiceWait, describeVoice, summariseVideo, buildReport };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.ProbeCore = api;
})(typeof window !== 'undefined' ? window : globalThis);
