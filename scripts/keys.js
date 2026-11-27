// Injected into the ws-scrcpy page by the workflow.
//
// Does three things:
//   1. opens the stream itself, preferring the WebCodecs player (hardware
//      decode in Chrome = the lowest-delay path) and falling back to H264;
//   2. turns WASD / arrows into a finger on Roblox's thumbstick, and space
//      into a finger on its jump button -- both sent through the stream's own
//      touch channel, so there is no extra network hop and no adb process per
//      key press, and the two fingers are independent (move and jump at once);
//   3. falls back to the phone-side key bridge whenever the page has no stream
//      to touch yet.
//
// window.__KEYURL / __DEVW / __DEVH are prepended by the workflow.
(function () {
  var base = window.__KEYURL || '';

  // ---- 1. auto-open the stream -------------------------------------------
  var opened = false;
  function autoOpen() {
    if (opened || (location.hash && location.hash.indexOf('action=stream') !== -1)) return;
    var links = document.querySelectorAll('a[href*="action=stream"]');
    if (!links.length) return;
    var want = typeof window.VideoDecoder === 'function' ? 'player=webcodecs' : 'player=mse';
    for (var i = 0; i < links.length; i++) {
      if (links[i].href.indexOf(want) !== -1) {
        opened = true;
        location.href = links[i].href;
        return;
      }
    }
  }
  setInterval(autoOpen, 2000);

  // ---- plumbing -----------------------------------------------------------
  var map = {
    KeyW: 'w',
    KeyA: 'a',
    KeyS: 's',
    KeyD: 'd',
    ArrowUp: 'w',
    ArrowLeft: 'a',
    ArrowDown: 's',
    ArrowRight: 'd',
    Space: 'jump',
  };
  var held = Object.create(null);

  function send(k, down) {
    if (!base) return;
    try {
      fetch(base + '/k?key=' + k + '&down=' + (down ? 1 : 0), {
        mode: 'no-cors',
        keepalive: true,
      });
    } catch (e) {}
  }

  function typing(t) {
    if (!t || !t.tagName) return false;
    var n = t.tagName.toLowerCase();
    if (n === 'input' || n === 'textarea' || n === 'select' || t.isContentEditable) return true;
    return !!(t.closest && t.closest('.xterm'));
  }

  function devSize() {
    var c = document.querySelector('canvas.video-layer');
    if (c && c.width > 100 && c.height > 100) return { w: c.width, h: c.height };
    var v = document.querySelector('video.video-layer');
    if (v && v.videoWidth > 100 && v.videoHeight > 100) return { w: v.videoWidth, h: v.videoHeight };
    if (window.__DEVW > 100 && window.__DEVH > 100) return { w: window.__DEVW, h: window.__DEVH };
    return null;
  }

  // ws-scrcpy listens on document.body and ignores any event whose target is
  // not its touch canvas, so everything is dispatched straight at that canvas.
  function canvasEl() {
    if (typeof window.Touch !== 'function' || typeof window.TouchEvent !== 'function') return null;
    var el = document.querySelector('canvas.touch-layer');
    if (!el || !el.getBoundingClientRect) return null;
    var r = el.getBoundingClientRect();
    return r.width > 40 && r.height > 40 ? el : null;
  }

  // Escape hatch: add &keys=bridge to the stream URL to go back to the
  // phone-side bridge without a new run.
  function forcedBridge() {
    return /(?:[?&#]|^)keys=bridge/.test((location.search || '') + (location.hash || ''));
  }

  function pageTouchOk() {
    return !forcedBridge() && !!(canvasEl() && devSize());
  }

  // Roblox sizes its touch controls off the short edge (<= 500px = phone
  // layout) and pins them to the corners with pixel offsets, not fractions:
  //   stick  70px at (25, h-90)      or 72px at (64, h-136) with abilities
  //   jump   70px at (w-95, h-90)    or 72px at (w-136, h-136) with abilities
  // The points below sit inside both variants, so one finger is enough.
  function layout(w, h) {
    if (Math.min(w, h) <= 500) {
      return { stick: { x: 80, y: h - 77, r: 35 }, jump: { x: w - 80, y: h - 77 } };
    }
    return { stick: { x: 140, y: h - 161, r: 60 }, jump: { x: w - 135, y: h - 161 } };
  }

  // ws-scrcpy letterboxes the video inside the canvas and removes that
  // letterbox from client coordinates itself, so aim at the content box.
  function toClient(el, w, h, x, y) {
    var rect = el.getBoundingClientRect();
    var cw = el.clientWidth || rect.width;
    var ch = el.clientHeight || rect.height;
    var ratio = w / h;
    var boxW = cw;
    var boxH = ch;
    var left = 0;
    var top = 0;
    if (Math.round(1e5 * ratio) > Math.round((1e5 * cw) / ch)) {
      boxH = Math.ceil(cw / ratio);
      top = (ch - boxH) / 2;
    } else if (Math.round(1e5 * ratio) < Math.round((1e5 * cw) / ch)) {
      boxW = Math.ceil(ch * ratio);
      left = (cw - boxW) / 2;
    }
    return {
      x: rect.left + left + (x / w) * boxW,
      y: rect.top + top + (y / h) * boxH,
    };
  }

  function fire(el, type, id, cx, cy) {
    try {
      var t = new window.Touch({
        identifier: id,
        target: el,
        clientX: cx,
        clientY: cy,
        pageX: cx,
        pageY: cy,
        screenX: cx,
        screenY: cy,
        radiusX: 8,
        radiusY: 8,
        rotationAngle: 0,
        force: type === 'touchend' ? 0 : 1,
      });
      el.dispatchEvent(
        new window.TouchEvent(type, {
          bubbles: true,
          cancelable: true,
          composed: true,
          touches: type === 'touchend' ? [] : [t],
          targetTouches: type === 'touchend' ? [] : [t],
          changedTouches: [t],
        }),
      );
    } catch (e) {}
  }

  // ---- 2. movement: one finger on the thumbstick --------------------------
  var stick = null;
  var stickSeq = 500;
  var stickMode = null; // 'page' while the stream can take touches, else 'bridge'

  function releaseStick() {
    if (!stick) return;
    fire(stick.el, 'touchend', stick.id, stick.cx, stick.cy);
    stick = null;
  }

  function updateStick() {
    var dx = (held.d ? 1 : 0) - (held.a ? 1 : 0);
    var dy = (held.s ? 1 : 0) - (held.w ? 1 : 0);
    if (!dx && !dy) {
      releaseStick();
      return;
    }
    var el = canvasEl();
    var size = devSize();
    if (!el || !size) {
      releaseStick();
      return;
    }
    var L = layout(size.w, size.h);
    var len = Math.sqrt(dx * dx + dy * dy);
    var to = toClient(el, size.w, size.h, L.stick.x + (dx / len) * L.stick.r, L.stick.y + (dy / len) * L.stick.r);
    if (!stick) {
      var at = toClient(el, size.w, size.h, L.stick.x, L.stick.y);
      stick = { id: stickSeq++, el: el, cx: at.x, cy: at.y };
      fire(el, 'touchstart', stick.id, at.x, at.y);
    }
    fire(el, 'touchmove', stick.id, to.x, to.y);
    stick.cx = to.x;
    stick.cy = to.y;
  }

  function pressMove(k) {
    if (held[k]) return;
    held[k] = 1;
    if (stickMode === null) stickMode = pageTouchOk() ? 'page' : 'bridge';
    if (stickMode === 'page') updateStick();
    else send(k, 1);
  }

  function releaseMove(k) {
    if (!held[k]) return;
    delete held[k];
    if (stickMode === 'page') {
      updateStick();
    } else {
      send(k, 0);
    }
    if (!held.w && !held.a && !held.s && !held.d) {
      releaseStick();
      stickMode = null;
    }
  }

  // ---- 3. space: its own finger on the jump button ------------------------
  var jumpTouch = null;
  var jumpPulse = null;
  var jumpBridge = false;
  var jumpSeq = 1;

  function pressJump() {
    var el = canvasEl();
    var size = devSize();
    if (el && size && !forcedBridge()) {
      releaseJump();
      var L = layout(size.w, size.h);
      var at = toClient(el, size.w, size.h, L.jump.x, L.jump.y);
      jumpTouch = { id: jumpSeq++, el: el, cx: at.x, cy: at.y };
      fire(el, 'touchstart', jumpTouch.id, at.x, at.y);
      // Roblox keeps jumping on landing while the button is held; the pulses
      // cover client versions that only jump on a fresh press.
      jumpPulse = setInterval(function () {
        if (!jumpTouch) return;
        fire(jumpTouch.el, 'touchend', jumpTouch.id, jumpTouch.cx, jumpTouch.cy);
        fire(jumpTouch.el, 'touchstart', jumpTouch.id, jumpTouch.cx, jumpTouch.cy);
      }, 250);
      return;
    }
    // No stream on this page (yet): let the phone-side bridge tap for us.
    if (!base) return;
    jumpBridge = true;
    send('jump', 1);
    jumpPulse = setInterval(function () {
      if (!jumpBridge) return;
      send('jump', 0);
      setTimeout(function () {
        if (jumpBridge) send('jump', 1);
      }, 80);
    }, 350);
  }

  function releaseJump() {
    if (jumpPulse) {
      clearInterval(jumpPulse);
      jumpPulse = null;
    }
    if (jumpTouch) {
      fire(jumpTouch.el, 'touchend', jumpTouch.id, jumpTouch.cx, jumpTouch.cy);
      jumpTouch = null;
    }
    if (jumpBridge) {
      jumpBridge = false;
      send('jump', 0);
    }
  }

  // ---- keys ---------------------------------------------------------------
  window.addEventListener(
    'keydown',
    function (e) {
      var k = map[e.code];
      if (!k || typing(e.target)) return;
      e.preventDefault();
      if (k === 'jump') {
        if (held.jump) return;
        held.jump = 1;
        pressJump();
        return;
      }
      pressMove(k);
    },
    true,
  );
  window.addEventListener(
    'keyup',
    function (e) {
      var k = map[e.code];
      if (!k) return;
      if (k === 'jump') {
        if (!held.jump) return;
        delete held.jump;
        releaseJump();
        return;
      }
      releaseMove(k);
    },
    true,
  );
  window.addEventListener('blur', function () {
    var moving = stickMode === 'bridge';
    Object.keys(held).forEach(function (k) {
      delete held[k];
    });
    if (moving) {
      send('w', 0);
      send('a', 0);
      send('s', 0);
      send('d', 0);
    }
    releaseStick();
    releaseJump();
    stickMode = null;
  });
})();
