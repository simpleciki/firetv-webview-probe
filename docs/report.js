// The probe's report page. A report arrives in the address after '#', which a browser keeps to
// itself: this page reads it, shows it, and sends it nowhere. Everything a report contains is
// treated as text from a stranger: it is only ever placed with textContent, never as HTML.
(function (root) {
  'use strict';
  const Core = typeof module !== 'undefined' && module.exports ? require('./probe-core.js') : root.ProbeCore;
  const REPO = 'https://github.com/simpleciki/firetv-webview-probe';

  const declared = (dev) => (dev && dev.sh === 'vega' ? dev.mc : dev && dev.vp);
  const seen = (v) => (typeof v !== 'string' ? 'not measured' : v[0] === 'y' ? 'visible' : v[0] === 'n' ? '**not visible**' : 'skipped');

  // One line per fact about the device, as [label, value].
  function deviceFacts(report) {
    const d = report.dev || {}, v = report.view || {};
    const vega = d.sh === 'vega';
    return [
      ['Device', d.m || (vega ? 'not reported by Vega OS' : 'unknown')],
      ['System', (d.f || 'unknown') + (d.a ? ' · Android ' + d.a + (d.s ? ' (API ' + d.s + ')' : '') : '')],
      ['WebView', d.w || 'unknown'],
      ['Display', (d.px || '?') + ' px · the page sees ' + v.w + '×' + v.h + ' CSS px · devicePixelRatio ' + v.dpr],
      ['Page origin', { appassets: 'https://appassets.androidplatform.net', file: 'file://', other: 'other' }[report.o] || 'unknown'],
      [vega ? 'Media declaration' : 'Voice permission', declared(d) ? 'declared in this build' : 'not declared in this build'],
      ['Measured on', measuredOn(report) || 'not recorded in this report (made by an earlier version of the probe)'],
    ];
  }
  // The day the TV ran the probe, from the report itself. Never the day this page was opened.
  const measuredOn = (report) => (typeof report.t === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(report.t) ? report.t : null);

  // 'y p1 a2.3 r4' in words: what the person answered, kept apart from what the <video> element reported.
  function videoWords(v) {
    const m = /^([yn-])(?: p([01]) a([\d.]+) r(\d))?$/.exec(v);
    if (!m) return v;
    const person = { y: 'The person saw it', n: 'The person did NOT see it', '-': 'Skipped' }[m[1]];
    if (m[2] === undefined) return person + '.';
    return person + '. The video element reported: ' + (m[2] === '1' ? 'playing' : 'paused') + ', clock advanced ' + m[3] + ' s, readyState ' + m[4] + '. (' + v + ')';
  }

  // One line per step, in the same words the TV used.
  function stepLines(report) {
    return Core.STEPS.filter((s) => report.r[s.id] !== undefined).map((s) => {
      const r = report.r[s.id];
      if (s.kind === 'keys') return [s.title, s.expect.map((w) => w + ': ' + (r[w] || 'not received')).join(' · ') + (r.skipped ? ' (skipped)' : '')];
      if (s.kind === 'voice') return [s.title, (r.length ? r.join(' ') + ' — ' : '') + Core.describeVoice(r)];
      return [s.title, videoWords(String(r))];
    });
  }

  const keysCell = (r, names) => {
    if (!r || r.skipped) return 'not measured (step skipped)';
    const vals = names.map((n) => r[n] || 'not received');
    return vals.every((x) => x === vals[0]) ? '`' + vals[0] + '`' : names.map((n, i) => n + ' `' + vals[i] + '`').join(', ');
  };
  const voiceCell = (r) => Core.STEPS.filter((s) => s.kind === 'voice' && r[s.id] !== undefined)
    .map((s) => s.title.replace('Voice: ', '') + ': ' + (r[s.id].filter((t) => t !== 'skipped').map((t) => '`' + t + '`').join(' ') || 'nothing')).join('; ') || 'not measured';

  // The report as one row of the README's "Measured devices" table. The last cell is the day the TV
  // measured; a report without one says so, and gives the day it was read so nobody mistakes the two.
  function markdownRow(report, today) {
    const d = report.dev || {}, v = report.view || {}, r = report.r, voice = voiceCell(r);
    const cells = [
      d.m || 'Vega OS device', (d.f || '?') + ' · WebView ' + (d.w || '?'), v.w + '×' + v.h + ', DPR ' + v.dpr,
      keysCell(r.dpad, ['up', 'down', 'left', 'right', 'select']), keysCell(r.transport, ['playPause', 'rewind', 'fastForward']), keysCell(r.menu, ['menu']),
      declared(d) ? voice : '—', declared(d) ? '—' : voice, seen(r.videoRounded), seen(r.videoHeldFade), measuredOn(report) || 'not recorded (report read ' + today + ')',
    ];
    return '| ' + cells.map((c) => String(c).replace(/\|/g, '\\|')).join(' | ') + ' |';
  }

  const api = { deviceFacts, stepLines, videoWords, markdownRow, REPO };
  if (typeof module !== 'undefined' && module.exports) { module.exports = api; return; }

  // ---- the page ----
  const $ = (id) => document.getElementById(id);
  const el = (tag, text) => { const e = document.createElement(tag); if (text != null) e.textContent = text; return e; };
  function table(rows) {
    const t = el('table');
    for (const [k, v] of rows) { const tr = el('tr'); tr.append(el('th', k), el('td', v)); t.append(tr); }
    return t;
  }
  function copyButton(label, text) {
    const b = el('button', label);
    b.addEventListener('click', () => {
      const done = () => { b.textContent = 'Copied'; setTimeout(() => { b.textContent = label; }, 1500); };
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done, () => { $('fallback').value = text; $('fallback').hidden = false; $('fallback').select(); });
      else { $('fallback').value = text; $('fallback').hidden = false; $('fallback').select(); }
    });
    return b;
  }
  function render() {
    const main = $('report');
    main.textContent = '';
    if (!location.hash || location.hash === '#') { $('intro').hidden = false; return; }
    const report = Core.parseReport(location.hash);
    if (!report) {
      main.append(el('h2', 'This link does not hold a probe report'), el('p', 'The part after # could not be read as a report. Scan the QR code on the TV again, or paste what you have below to keep it.'));
      $('fallback').value = location.hash.slice(1); $('fallback').hidden = false;
      return;
    }
    $('intro').hidden = true;
    const now = new Date(), today = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0') + '-' + String(now.getDate()).padStart(2, '0');
    const row = markdownRow(report, today), json = JSON.stringify(report, null, 1);
    main.append(el('h2', 'What this device delivered'), table(deviceFacts(report)), table(stepLines(report)),
      el('p', 'Doors: d = DOM keydown · k = activity key event (v = virtual device) · m = media-button intent · s = media-session callback · t = app shell TV event · v: = the system acting on the page’s video · L = app paused/resumed'));
    const actions = el('div'); actions.className = 'actions';
    const issue = el('a', 'Add this device to the list');
    issue.className = 'button';
    issue.href = REPO + '/issues/new?title=' + encodeURIComponent('Device report: ' + ((report.dev && (report.dev.m || report.dev.f)) || 'unknown device')) +
      '&body=' + encodeURIComponent('Row for the "Measured devices" table:\n\n' + row + '\n\nFull report:\n\n```json\n' + json + '\n```\n');
    actions.append(copyButton('Copy report', json), copyButton('Copy as a table row', row), issue);
    main.append(actions, el('p', 'The first two buttons copy to your clipboard and send nothing. The third opens a new issue on GitHub with the report filled in; nothing is posted until you press Submit there.'));
  }
  window.addEventListener('hashchange', render);
  render();
})(typeof window !== 'undefined' ? window : globalThis);
