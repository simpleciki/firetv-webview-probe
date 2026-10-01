// probe-ui — runs the steps on the TV: shows each prompt, records what arrives, and ends with a
// results table and a QR code of the report. All judgement lives in probe-core.js.
(function () {
  'use strict';
  const { STEPS, summariseKeys, summariseVoice, describeVoice, summariseVideo, buildReport } = window.ProbeCore;
  const RA = window.RemoteActions;
  const native = window.ProbeNative || null; // absent when the page is opened in a desktop browser
  const screen = document.getElementById('screen');

  const KEYS_SETTLE_MS = 1500;  // after the last expected key: wait for the same press through a second door
  const VOICE_SETTLE_MS = 3000; // after the first thing arrives for a phrase: collect the rest
  const VIDEO_CHECK_MS = 2500;  // how long the video element is watched before asking the person
  // The press that opened a step (OK on the start screen, an answer on the previous step) can
  // still be arriving through its second door when the step begins. Nothing is recorded in the
  // first moments of a step, so one step's press never becomes the next step's evidence.
  const STEP_GUARD_MS = 400;

  // ---- tiny DOM helpers (textContent only: device strings are never parsed as HTML) ----
  function el(tag, cls, text) { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  function show(...nodes) { screen.replaceChildren(...nodes); }
  function hint(text) { return el('p', 'hint', text); }

  // ---- environment ----
  function readEnv() {
    let device = null;
    try { device = native ? JSON.parse(native.info()) : null; } catch (e) { device = null; }
    return { device, innerWidth, innerHeight, devicePixelRatio, origin: location.origin, userAgent: navigator.userAgent };
  }

  // ---- input: every door, raw, plus one de-duplicated stream for navigating the probe ----
  let onRaw = null;   // the running step's recorder: receives { kind, ... } observations
  let onNav = null;   // the current screen's navigation handler: receives action names
  const nav = RA.create({ onAction: (a) => onNav && onNav(a.action) });

  document.addEventListener('keydown', (e) => {
    const a = RA.fromDomKey(e);
    if (a) { e.preventDefault(); if (onRaw) onRaw({ kind: 'dom', action: a.action }); }
    nav.handleDom(e);
  });
  window.addEventListener('probe-native', (ev) => {
    const d = ev.detail;
    console.log('[probe] native', JSON.stringify(d));
    if (onRaw && d.kind !== 'state') onRaw(d);
    nav.handleNative(d);
  });

  // ---- start screen ----
  let env = readEnv();
  function startScreen() {
    onRaw = null;
    const d = env.device;
    const rows = d ? [
      ['Device', `${d.manufacturer} ${d.model} (${d.device})`],
      ['System', `${d.fireOs || 'Android ' + d.android} · API ${d.sdk}`],
      ['WebView', d.webview || 'unknown'],
      ['Display', `${d.displayPx} px · page sees ${env.innerWidth}×${env.innerHeight} CSS px · devicePixelRatio ${env.devicePixelRatio}`],
      ['Page origin', env.origin],
      ['Voice permission', d.voicePermission ? 'declared in this build' : 'not declared in this build'],
    ] : [['Shell', 'Not running inside the probe app: only DOM keys can be recorded.']];
    const t = el('table');
    for (const [k, v] of rows) { const tr = el('tr'); tr.append(el('th', null, k), el('td', null, v)); t.append(tr); }
    show(el('h1', null, 'Fire TV WebView Probe'),
      el('p', 'dim', 'Finds out what this device actually delivers to a web page in a WebView app: remote keys, Alexa voice commands, and which video styles stay visible. About three minutes.'),
      t,
      hint('OK  start      Back  exit'));
    onNav = (a) => { if (a === 'select') run(); else if (a === 'back' && native) native.exit(); };
  }

  // ---- step runner ----
  let results = {};
  async function run() {
    results = {};
    env = readEnv();
    for (let i = 0; i < STEPS.length; i++) {
      const s = STEPS[i];
      const header = [el('p', 'progress', `Step ${i + 1} of ${STEPS.length}`), el('h2', null, s.title)];
      if (s.kind === 'keys') results[s.id] = await keysStep(s, header);
      else if (s.kind === 'voice') results[s.id] = await voiceStep(s, header);
      else if (s.kind === 'video') results[s.id] = await videoStep(s, header);
    }
    if (native) native.setPlaying(false);
    resultsScreen();
  }

  function waitFor(ms) { return new Promise((r) => setTimeout(r, ms)); }

  function keysStep(s, header) {
    return new Promise((resolve) => {
      const actions = [];
      const log = el('div', 'log');
      show(...header, el('p', 'prompt', s.prompt), log, hint('Nothing to press? Wait, or press Back to skip.'));
      let settle = null;
      const started = performance.now();
      const done = setTimeout(finish, s.timeoutMs);
      function finish(skipped) {
        clearTimeout(done); clearTimeout(settle); onRaw = null; onNav = null;
        const r = summariseKeys(s, actions); if (skipped === true) r.skipped = 1; resolve(r);
      }
      onNav = null;
      onRaw = (o) => {
        if (o.kind === 'back') { finish(true); return; }
        if (performance.now() - started < STEP_GUARD_MS) return;
        const a = o.kind === 'dom' ? { action: o.action, source: 'dom' } : RA.fromNative(o);
        if (!a) return;
        actions.push(a);
        log.textContent = s.expect.map((w) => {
          const doors = summariseKeys(s, actions)[w];
          return `${w.padEnd(12)} ${doors ? 'received via ' + doors.split('').map((x) => ({ d: 'DOM', k: 'key event', m: 'media button', s: 'session' })[x]).join(' + ') : '…'}`;
        }).join('\n');
        if (s.expect.every((w) => actions.some((x) => x.action === w))) { clearTimeout(settle); settle = setTimeout(finish, KEYS_SETTLE_MS); }
      };
    });
  }

  function voiceStep(s, header) {
    return new Promise((resolve) => {
      if (native) native.setPlaying(s.state === 'playing');
      const obs = [];
      const log = el('div', 'log');
      show(...header,
        el('p', 'dim', `The app now tells Fire TV it is ${s.state === 'playing' ? 'playing' : 'paused'}.`),
        el('p', 'prompt', `Say “${s.phrase}”`),
        log, hint('Hold the remote’s microphone button, or speak to a paired Echo. Back to skip.'));
      let settle = null;
      const started = performance.now();
      const done = setTimeout(finish, s.timeoutMs);
      function finish(skipped) {
        clearTimeout(done); clearTimeout(settle); onRaw = null;
        const r = summariseVoice(obs); if (skipped === true) r.push('skipped'); resolve(r);
      }
      onNav = null;
      onRaw = (o) => {
        if (o.kind === 'back') { finish(true); return; }
        // Back is how a person skips this step, not something Alexa sent.
        if (o.kind === 'key' && o.code === 4) return;
        if (performance.now() - started < STEP_GUARD_MS) return;
        obs.push(o);
        const tokens = summariseVoice(obs);
        log.textContent = tokens.join('  ') + '\n' + describeVoice(tokens);
        if (!settle) settle = setTimeout(finish, VOICE_SETTLE_MS);
      };
    });
  }

  function videoStep(s, header) {
    return new Promise((resolve) => {
      onRaw = null;
      const v = el('video');
      v.src = 'test-clip.mp4'; v.muted = true; v.loop = true; v.playsInline = true;
      if (s.variant === 'rounded') v.className = 'rounded';
      document.body.classList.remove('fade-held', 'fade-ending');
      if (s.variant === 'held-fade') document.body.classList.add('fade-held');
      if (s.variant === 'ending-fade') document.body.classList.add('fade-ending');
      const ask = el('p', 'prompt', 'Watching the video for a moment…');
      const stage = el('div', 'stage'); stage.append(v, ask);
      show(...header, stage, hint('Back to skip.'));
      v.play().catch(() => {});
      let measured = null;
      const t0 = v.currentTime;
      setTimeout(() => {
        measured = { paused: v.paused, readyState: v.readyState, advancedS: Math.max(0, v.currentTime - t0) };
        ask.textContent = 'Can you see moving colour bars and a running clock?   →  yes    ←  no';
        onNav = (a) => {
          if (a === 'right') finish('seen'); else if (a === 'left') finish('not-seen'); else if (a === 'back') finish('skipped');
        };
      }, VIDEO_CHECK_MS);
      onNav = (a) => { if (a === 'back') finish('skipped'); };
      function finish(answer) {
        onNav = null;
        v.pause(); v.removeAttribute('src'); v.load();
        document.body.classList.remove('fade-held', 'fade-ending');
        resolve(summariseVideo(answer, measured));
      }
    });
  }

  // ---- results ----
  function resultsScreen() {
    onRaw = null;
    const report = buildReport(env, results);
    console.log('[probe] report', report);
    const t = el('table');
    for (const s of STEPS) {
      const r = results[s.id];
      let text;
      if (s.kind === 'keys') text = s.expect.map((w) => `${w}: ${r[w] || 'not received'}`).join(' · ') + (r.skipped ? ' (skipped)' : '');
      else if (s.kind === 'voice') text = (r.length ? r.join(' ') + ' — ' : '') + describeVoice(r);
      else text = r;
      const tr = el('tr'); tr.append(el('th', null, s.title), el('td', null, text)); t.append(tr);
    }
    const tableBox = el('div', 'table'); tableBox.append(t);
    const qrBox = el('div', 'qr');
    try {
      const q = window.qrcode(0, 'L'); q.addData(report, 'Byte'); q.make();
      qrBox.innerHTML = q.createSvgTag({ cellSize: 4, margin: 4, scalable: true }); // generated SVG, no device text inside
    } catch (e) { qrBox.textContent = 'Report too large for a QR code.'; }
    qrBox.append(el('p', 'dim', 'Scan to keep this report'));
    const box = el('div', 'results'); box.append(tableBox, qrBox);
    show(el('h1', null, 'What this device delivered'),
      el('p', 'dim', 'Doors: d = DOM keydown · k = activity key event (v = virtual device) · m = media-button intent · s = media-session callback · L = app paused/resumed'),
      box, hint('OK  run again      Back  exit'));
    onNav = (a) => { if (a === 'select') run(); else if (a === 'back' && native) native.exit(); };
  }

  startScreen();
})();
