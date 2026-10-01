// remote-actions — one set of action names for everything a Fire TV remote or Alexa can send
// to a web page running in a WebView app.
//
// A press can reach you through three doors, and which door it uses depends on the device,
// the OS version and what your app declares:
//   1. DOM keydown in the page        ({ key: 'MediaPlayPause' })
//   2. the activity's key events      ({ kind: 'key', code: 85, deviceId: -1 })   forwarded by your shell
//   3. media-session callbacks        ({ kind: 'session', callback: 'onPause' }) forwarded by your shell
// This module names the action the same way whichever door it came through, keeps the door
// (`source`) so you can tell them apart, and drops the duplicate when one press comes through
// two doors at once. It decides nothing about what an action means in your app.
//
// No dependencies. Works in a browser (window.RemoteActions) and in Node (require).
(function (root) {
  'use strict';

  // DOM `KeyboardEvent.key` values seen from Fire TV remotes in Android WebView.
  const DOM_KEYS = {
    ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right',
    Enter: 'select',
    GoBack: 'back', BrowserBack: 'back', Escape: 'back',
    ContextMenu: 'menu',
    MediaPlayPause: 'playPause', MediaPlay: 'play', MediaPause: 'pause', MediaStop: 'stop',
    MediaRewind: 'rewind', MediaFastForward: 'fastForward',
    MediaTrackNext: 'next', MediaTrackPrevious: 'previous',
  };

  // Android `KeyEvent` key codes.
  const KEY_CODES = {
    19: 'up', 20: 'down', 21: 'left', 22: 'right', 23: 'select', 66: 'select',
    4: 'back', 82: 'menu',
    85: 'playPause', 126: 'play', 127: 'pause', 86: 'stop',
    89: 'rewind', 90: 'fastForward', 87: 'next', 88: 'previous',
  };

  const SESSION_CALLBACKS = {
    onPlay: 'play', onPause: 'pause', onStop: 'stop',
    onRewind: 'rewind', onFastForward: 'fastForward',
    onSkipToNext: 'next', onSkipToPrevious: 'previous',
  };

  // A DOM keydown → { action, source: 'dom', key } or null for keys this module doesn't name.
  function fromDomKey(e) {
    const action = DOM_KEYS[e && e.key];
    return action ? { action, source: 'dom', key: e.key } : null;
  }

  // An event forwarded by the native shell → { action, source, ... } or null.
  //  - key / mediaButton: { code, deviceId }. `deviceId: -1` means no physical input device sent
  //    it; on a Fire TV Stick 4K Plus (Fire OS 8.1.6.0) that is how Alexa's commands arrived
  //    when the app lacked Amazon's voice permission. Reported as `virtual`, not as "voice":
  //    the probe exists so you check that on your own device.
  //  - session onSeekTo(pos): Amazon sends "Alexa, rewind / fast forward" as a seek to the
  //    session's position ± an offset (10 s by default), and "Alexa, restart" as a seek to 0.
  //    Pass the position your session reported as `anchor` to get a direction.
  function fromNative(d) {
    if (!d) return null;
    if (d.kind === 'key' || d.kind === 'mediaButton') {
      const action = KEY_CODES[d.code];
      if (!action) return null;
      return { action, source: d.kind === 'key' ? 'key' : 'mediaButton', code: d.code, virtual: d.deviceId === -1 };
    }
    if (d.kind === 'back') return { action: 'back', source: 'key', code: 4, virtual: false };
    if (d.kind === 'session') {
      if (d.callback === 'onSeekTo') {
        if (d.pos === 0) return { action: 'restart', source: 'session' };
        if (typeof d.anchor !== 'number') return { action: 'seek', source: 'session', pos: d.pos };
        const deltaMs = d.pos - d.anchor;
        if (deltaMs === 0) return null;
        return { action: deltaMs < 0 ? 'seekBack' : 'seekForward', source: 'session', deltaMs };
      }
      const action = SESSION_CALLBACKS[d.callback];
      return action ? { action, source: 'session' } : null;
    }
    return null;
  }

  // Wire both doors to one callback. `now` is injectable for tests; it must be one clock for
  // every event this instance sees (the page's own clock, at the moment the page handles it).
  function create(opts) {
    const onAction = opts.onAction;
    const windowMs = opts.dedupeMs == null ? 80 : opts.dedupeMs;
    const now = opts.now || (() => (typeof performance !== 'undefined' ? performance.now() : Date.now()));
    let last = null; // { action, source, t }
    function emit(a) {
      if (!a) return false;
      const t = now();
      // The same action through a different door within the window is the same press.
      if (last && last.action === a.action && last.source !== a.source && t - last.t <= windowMs) return false;
      last = { action: a.action, source: a.source, t };
      onAction(a);
      return true;
    }
    return {
      handleDom: (e) => emit(fromDomKey(e)),
      handleNative: (d) => emit(fromNative(d)),
    };
  }

  const api = { fromDomKey, fromNative, create, DOM_KEYS, KEY_CODES, SESSION_CALLBACKS };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.RemoteActions = api;
})(typeof window !== 'undefined' ? window : globalThis);
