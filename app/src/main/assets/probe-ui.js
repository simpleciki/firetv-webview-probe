// probe-ui — runs the steps on the TV: shows each prompt, records what arrives, and ends with a
// results table and a QR code of the report. All judgement lives in probe-core.js.
(function () {
  'use strict';
  const { STEPS, summariseKeys, voiceToken, summariseVoice, voiceSettleMs, describeVoice, summariseVideo, localDay, buildReport, reportLink } = window.ProbeCore;
  const RA = window.RemoteActions;
  const native = window.ProbeNative || null; // absent when the page is opened in a desktop browser
  const screen = document.getElementById('screen');

  const KEYS_SETTLE_MS = 1500;  // after the last expected key: wait for the same press through a second door
  const VIDEO_CHECK_MS = 2500;  // how long the video element is watched before asking the person
  // The press that opened a step (OK on the start screen, an answer on the previous step) can
  // still be arriving through its second door when the step begins. Nothing is recorded in the
  // first moments of a step, so one step's press never becomes the next step's evidence.
  const STEP_GUARD_MS = 400;

  // ---- tiny DOM helpers (textContent only: device strings are never parsed as HTML) ----
  function el(tag, cls, text) { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  // A Back press reaches the page through two doors; the second copy must not skip the next step too
  // (4K Plus, 2026-10-01: twelve Backs ran past the results screen and closed the app).
  let shownAt = 0;
  function show(...nodes) { screen.replaceChildren(...nodes); shownAt = performance.now(); }
  function settled() { return performance.now() - shownAt >= STEP_GUARD_MS; }
  function hint(text) { return el('p', 'hint', text); }

  // ---- environment ----
  function readEnv() {
    let device = null;
    try { device = native ? JSON.parse(native.info()) : null; } catch (e) { device = null; }
    // The Vega shell cannot see its WebView's version; the page can, in its own user agent.
    if (device && device.shell === 'vega' && !device.webview) {
      const m = /Chrome\/([\d.]+)/.exec(navigator.userAgent);
      device.webview = m ? 'Chrome ' + m[1] : '';
    }
    return { device, innerWidth, innerHeight, devicePixelRatio, origin: location.origin, userAgent: navigator.userAgent };
  }

  // ---- input: every door, raw, plus one de-duplicated stream for navigating the probe ----
  let onRaw = null;   // the running step's recorder: receives { kind, ... } observations
  let onNav = null;   // the current screen's navigation handler: receives action names
  const nav = RA.create({ onAction: (a) => onNav && onNav(a.action) });

  document.addEventListener('keydown', (e) => {
    const a = RA.fromDomKey(e);
    // Back reaches the page only where the shell hands system keys to the web layer (Vega OS);
    // there, as on Fire OS, it means "skip this step".
    if (a) { e.preventDefault(); if (onRaw) onRaw(a.action === 'back' ? { kind: 'back' } : { kind: 'dom', action: a.action }); }
    else if (onRaw) onRaw({ kind: 'domOther', key: (e.key || '') + '/' + e.keyCode });
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
  // At first paint the page can still measure 0×0 (seen on Fire OS 8.1.8.2): fill the row in once layout settles.
  function displayText(d) { return `${d.displayPx} px · page sees ${env.innerWidth}×${env.innerHeight} CSS px · devicePixelRatio ${env.devicePixelRatio}`; }
  let displayCell = null;
  window.addEventListener('resize', () => {
    env = readEnv();
    if (displayCell && displayCell.isConnected && env.device) displayCell.textContent = displayText(env.device);
  });
  function startScreen() {
    onRaw = null;
    const d = env.device;
    const rows = d && d.shell === 'vega' ? [
      ['Device', `${d.manufacturer || ''} ${d.model || ''}`.trim() ||
        (d.constants ? 'not reported; the app layer offers: ' + Object.keys(d.constants).join(', ') : 'unknown')],
      ['System', d.os || 'Vega OS'],
      ['WebView', d.webview || 'unknown'],
      ['Display', displayText(d)],
      ['Page origin', env.origin],
      ['Media declaration', d.mediaControl ? 'this build’s manifest declares the media-control block from Amazon’s WebView guide' : 'this build’s manifest is the WebView template’s, with no media declaration'],
    ] : d ? [
      ['Device', `${d.manufacturer} ${d.model} (${d.device})`],
      ['System', `${d.fireOs || 'Android ' + d.android} · API ${d.sdk}`],
      ['WebView', d.webview || 'unknown'],
      ['Display', displayText(d)],
      ['Page origin', env.origin],
      ['Voice permission', d.voicePermission ? 'declared in this build' : 'not declared in this build'],
    ] : [['Shell', 'Not running inside the probe app: only DOM keys can be recorded.']];
    const t = el('table');
    displayCell = null;
    for (const [k, v] of rows) { const tr = el('tr'); const td = el('td', null, v); if (k === 'Display') displayCell = td; tr.append(el('th', null, k), td); t.append(tr); }
    show(el('h1', null, 'Fire TV WebView Probe'),
      el('p', 'dim', 'Finds out what this device actually delivers to a web page in a WebView app: remote keys, Alexa voice commands, and which video styles stay visible. About three minutes.'),
      t,
      hint('OK  start      Back  exit'));
    onNav = (a) => { if (a === 'select') run(); else if (a === 'back' && native && settled()) native.exit(); };
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
        if (o.kind === 'back') { if (settled()) finish(true); return; }
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

  // Where the shell has no media session of its own (Vega OS), the media Alexa can act on is the
  // page's own <video>, so the voice steps play one (with a silent audio track) in the stated
  // state. Its play / pause / seeked events count only once the page's own play() or pause()
  // has landed, so what is recorded is what the system did to it.
  function pageMedia(state, record) {
    const v = el('video', 'voice-video');
    v.src = 'voice-clip.mp4'; v.playsInline = true; // not looped: a loop fires its own 'seeked'
    let armed = false, lastT = 0, seekFrom = null, off = false;
    const arm = () => setTimeout(() => { if (!off) armed = true; }, 300);
    // The seek's starting point is taken when 'seeking' fires: a seek's own 'timeupdate' (already at
    // the new position, with seeking false) arrives before 'seeked' (4K Select, 2026-10-03: every seek read as 0).
    v.addEventListener('timeupdate', () => { if (!v.seeking && seekFrom === null) lastT = v.currentTime; });
    v.addEventListener('seeking', () => { if (seekFrom === null) seekFrom = lastT; });
    for (const ev of ['play', 'pause', 'seeked']) {
      v.addEventListener(ev, () => {
        const from = seekFrom;
        if (ev === 'seeked') { seekFrom = null; lastT = v.currentTime; }
        if (off || !armed) return;
        record(ev === 'seeked' ? { kind: 'video', event: ev, delta: from === null ? undefined : v.currentTime - from } : { kind: 'video', event: ev });
      });
    }
    v.addEventListener('playing', () => {
      if (state === 'paused' && !armed) { v.addEventListener('pause', arm, { once: true }); v.pause(); }
      else if (!armed) arm();
    }, { once: true });
    v.play().catch(() => {});
    return { node: v, stop() { off = true; v.pause(); v.removeAttribute('src'); v.load(); } };
  }

  function voiceStep(s, header) {
    return new Promise((resolve) => {
      if (native) native.setPlaying(s.state === 'playing');
      const obs = [];
      const log = el('div', 'log');
      const media = env.device && env.device.pageMedia ? pageMedia(s.state, (o) => onRaw && onRaw(o)) : null;
      show(...header,
        el('p', 'dim', media
          ? `The video below is ${s.state === 'playing' ? 'playing' : 'paused'}.`
          : `The app now tells Fire TV it is ${s.state === 'playing' ? 'playing' : 'paused'}.`),
        ...(media ? [media.node] : []),
        el('p', 'prompt', `Say “${s.phrase}”`),
        log, hint('Hold the remote’s microphone button, or speak to a paired Echo. Back to skip.'));
      let settle = null;
      const times = [];
      const started = performance.now();
      const done = setTimeout(finish, s.timeoutMs);
      function finish(skipped) {
        clearTimeout(done); clearTimeout(settle); onRaw = null;
        if (media) media.stop();
        const r = summariseVoice(obs); if (skipped === true) r.push('skipped'); resolve(r);
      }
      onNav = null;
      onRaw = (o) => {
        if (o.kind === 'back') { if (settled()) finish(true); return; }
        // Back is how a person skips this step, not something Alexa sent.
        if (o.kind === 'key' && o.code === 4) return;
        if (performance.now() - started < STEP_GUARD_MS) return;
        obs.push(o);
        // Seconds since the prompt, on screen only: tells a press of the microphone button apart from the answer.
        const tok = voiceToken(o);
        if (tok) times.push(`+${((performance.now() - started) / 1000).toFixed(1)}s ${tok}`);
        const tokens = summariseVoice(obs);
        log.textContent = times.join('  ') + '\n' + describeVoice(tokens);
        const ms = voiceSettleMs(o);
        if (ms != null) { clearTimeout(settle); settle = setTimeout(finish, ms); }
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
          if (a === 'right') finish('seen'); else if (a === 'left') finish('not-seen'); else if (a === 'back' && settled()) finish('skipped');
        };
      }, VIDEO_CHECK_MS);
      onNav = (a) => { if (a === 'back' && settled()) finish('skipped'); };
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
    const report = buildReport({ ...env, measuredOn: localDay(new Date()) }, results);
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
      const q = window.qrcode(0, 'L'); q.addData(reportLink(report), 'Byte'); q.make();
      qrBox.innerHTML = q.createSvgTag({ cellSize: 4, margin: 4, scalable: true }); // generated SVG, no device text inside
    } catch (e) { qrBox.textContent = 'Report too large for a QR code.'; }
    qrBox.append(el('p', 'dim', 'Scan to open this report on your phone'), el('p', 'dim small', 'The report travels inside the link. Nothing is uploaded.'));
    const box = el('div', 'results'); box.append(tableBox, qrBox);
    show(el('h1', null, 'What this device delivered'),
      el('p', 'dim', 'Doors: d = DOM keydown · k = activity key event (v = virtual device) · m = media-button intent · s = media-session callback · L = app paused/resumed'),
      box, hint('OK  run again      Back  exit'));
    onNav = (a) => { if (a === 'select') run(); else if (a === 'back' && native && settled()) native.exit(); };
  }

  startScreen();
})();
