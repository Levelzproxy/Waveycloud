// Runs the injected page script against a stubbed DOM to check what it sends.
const fs = require('fs');
const vm = require('vm');
const code = fs.readFileSync('scripts/keys.js', 'utf8');

function harness(withCanvas, search) {
  const events = [];
  const calls = [];
  const listeners = {};
  const intervals = [];
  const canvas = {
    clientWidth: 1280,
    clientHeight: 720,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 1280, height: 720 }),
    dispatchEvent(ev) {
      ev.target = this;
      events.push(ev);
      return true;
    },
  };
  const doc = {
    querySelector(sel) {
      if (sel === 'canvas.touch-layer') return withCanvas ? canvas : null;
      if (sel === 'canvas.video-layer') return withCanvas ? { width: 854, height: 480 } : null;
      return null;
    },
  };
  const win = {
    __KEYURL: 'https://k.example',
    __DEVW: 854,
    __DEVH: 480,
    VideoDecoder: function () {},
    addEventListener(t, f) {
      (listeners[t] = listeners[t] || []).push(f);
    },
    Touch: class {
      constructor(i) {
        Object.assign(this, i);
      }
    },
    TouchEvent: class {
      constructor(t, i) {
        this.type = t;
        Object.assign(this, i);
        this.cancelable = true;
      }
    },
    setInterval(fn) {
      intervals.push(fn);
      return intervals.length;
    },
    clearInterval() {},
    fetch(u) {
      calls.push(u);
    },
  };
  win.window = win;
  const ctx = vm.createContext({
    window: win,
    document: doc,
    location: { hash: '#action=stream', search: search || '' },
    setInterval: win.setInterval,
    clearInterval: win.clearInterval,
    fetch: win.fetch,
    console,
  });
  vm.runInContext(code, ctx);
  return { events, calls, listeners, intervals };
}

function key(h, type, code) {
  (h.listeners[type] || []).forEach((f) => f({ code, target: {}, preventDefault() {}, repeat: false }));
}

const at = (ev) => {
  const t = ev.changedTouches[0];
  return `${ev.type} id=${t.identifier} (${t.clientX.toFixed(1)}, ${t.clientY.toFixed(1)})`;
};

let pass = 0;
let fail = 0;
function ok(name, cond, extra) {
  if (cond) {
    pass++;
    console.log('  ok  ', name, extra || '');
  } else {
    fail++;
    console.log('  FAIL', name, extra || '');
  }
}

console.log('--- page mode: W then D then release ---');
let h = harness(true);
key(h, 'keydown', 'KeyW');
console.log('   ', h.events.map(at).join('\n    '));
ok('W starts a finger on the stick', h.events[0] && h.events[0].type === 'touchstart' && h.events[0].changedTouches[0].target === h.events[0].target);
ok('W pushes the stick up', h.events[1] && h.events[1].type === 'touchmove' && Math.abs(h.events[1].changedTouches[0].clientY - 552.0) < 0.2, `y=${h.events[1].changedTouches[0].clientY}`);
ok('no bridge calls while moving on the page', h.calls.length === 0);
key(h, 'keydown', 'KeyD');
ok('W+D sends a diagonal move', h.events.length === 3 && h.events[2].type === 'touchmove' && h.events[2].changedTouches[0].clientX > 119.9);
key(h, 'keyup', 'KeyW');
ok('releasing W keeps the finger down and moves to D', h.events.length === 4 && h.events[3].type === 'touchmove' && Math.abs(h.events[3].changedTouches[0].clientX - 172.4) < 0.5);
key(h, 'keyup', 'KeyD');
ok('releasing the last key lifts the finger', h.events.length === 5 && h.events[4].type === 'touchend');
ok('still no bridge traffic', h.calls.length === 0);

console.log('--- jump while moving ---');
h = harness(true);
key(h, 'keydown', 'KeyW');
key(h, 'keydown', 'Space');
const types = h.events.map((e) => e.type);
ok('move finger and jump finger coexist', types.join(',') === 'touchstart,touchmove,touchstart', types.join(','));
ok('jump uses a different identifier', h.events[2].changedTouches[0].identifier !== h.events[0].changedTouches[0].identifier);
h.intervals[h.intervals.length - 1]();
ok('holding space pulses the jump', h.events.slice(3).map((e) => e.type).join(',') === 'touchend,touchstart');
key(h, 'keyup', 'KeyW');
ok('lifting move leaves the jump finger alone', h.events[5].type === 'touchend' && h.events[5].changedTouches[0].identifier === h.events[0].changedTouches[0].identifier);
key(h, 'keyup', 'Space');
ok('lifting space ends the jump finger', h.events[h.events.length - 1].type === 'touchend');

console.log('--- fallback: no stream on the page yet ---');
h = harness(false);
key(h, 'keydown', 'KeyW');
key(h, 'keyup', 'KeyW');
key(h, 'keydown', 'Space');
key(h, 'keyup', 'Space');
console.log('   ', h.calls.join('\n    '));
ok('WASD goes to the bridge', h.calls.includes('https://k.example/k?key=w&down=1') && h.calls.includes('https://k.example/k?key=w&down=0'));
ok('space goes to the bridge', h.calls.includes('https://k.example/k?key=jump&down=1') && h.calls.includes('https://k.example/k?key=jump&down=0'));
ok('no page touches without a canvas', h.events.length === 0);

console.log('--- escape hatch: &keys=bridge in the URL ---');
h = harness(true, '?action=stream&player=webcodecs&keys=bridge');
key(h, 'keydown', 'KeyW');
key(h, 'keyup', 'KeyW');
ok('movement goes to the bridge', h.calls.includes('https://k.example/k?key=w&down=1') && h.calls.includes('https://k.example/k?key=w&down=0'));
ok('no page touches with the flag set', h.events.length === 0);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
