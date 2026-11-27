// WASD -> Roblox's on-screen thumbstick, via adb `input motionevent`.
//
// Roblox ignores scrcpy's injected key codes (it only enables keyboard controls
// when Android reports a hardware keyboard), so the stick is dragged with real
// touches instead, and space taps the on-screen jump button the same way. The device boots landscape, but Roblox can still rotate it,
// so the screen size is derived from the live SurfaceOrientation rather than
// assumed -- that mismatch is what made earlier builds do nothing.
const http = require('http');
const { spawn, exec } = require('child_process');

const BASE_W = parseInt(process.env.DEV_W || '640', 10);
const BASE_H = parseInt(process.env.DEV_H || '360', 10);

const sh = spawn('adb', ['-s', 'localhost:5555', 'shell']);
sh.stdout.resume();
sh.stderr.resume();
sh.on('exit', () => process.exit(0));

let rotation = 0;
let lastError = '';
let lastCommand = '';

function readRotation() {
  exec('adb -s localhost:5555 shell dumpsys input | grep -m1 -i SurfaceOrientation', (err, out) => {
    if (err) {
      lastError = String(err.message).slice(0, 120);
      return;
    }
    const m = /SurfaceOrientation:\s*(\d)/.exec(out || '');
    if (m) rotation = parseInt(m[1], 10) % 4;
  });
}
readRotation();
setInterval(readRotation, 5000).unref();

function screen() {
  return rotation === 1 || rotation === 3 ? { w: BASE_H, h: BASE_W } : { w: BASE_W, h: BASE_H };
}

// Roblox's touch controls move with the screen: TouchThumbstick and TouchJump
// size themselves off the short edge (<= 500px = phone layout) and sit in the
// corners at fixed pixel offsets, not fractions. These are those offsets, so a
// press lands on the control at any resolution we boot.
function layout() {
  const { w, h } = screen();
  if (Math.min(w, h) <= 500) {
    return {
      // phone: stick 70px at (25, h-90) or, with avatar abilities, 72px at (64, h-136)
      stick: { x: 80, y: h - 77, r: 35 },
      // phone: jump 72px at (w-136, h-136) or, classic, 70px at (w-95, h-90).
      // (w-80, h-77) is inside both, so one tap always hits the button.
      jump: [{ x: w - 80, y: h - 77 }],
    };
  }
  return {
    // tablet: stick 120px at (60, h-210) or, with avatar abilities, at (100, h-232)
    stick: { x: 140, y: h - 161, r: 60 },
    // tablet: jump 120px at (w-220, h-232) or, classic, at (w-170, h-210)
    jump: [{ x: w - 135, y: h - 161 }],
  };
}

function anchor() {
  const { w, h } = screen();
  return { ...layout().stick, w, h };
}

function cmd(c) {
  lastCommand = c;
  try {
    sh.stdin.write(c + '\n');
  } catch (e) {
    lastError = 'adb stdin closed: ' + String(e.message).slice(0, 80);
  }
}

const held = Object.create(null);
let touching = false;

function release() {
  const a = anchor();
  cmd('input motionevent MOVE ' + a.x + ' ' + a.y);
  cmd('input motionevent UP ' + a.x + ' ' + a.y);
  touching = false;
}

function update() {
  const a = anchor();
  const dx = (held.d ? 1 : 0) - (held.a ? 1 : 0);
  const dy = (held.s ? 1 : 0) - (held.w ? 1 : 0);
  if (dx || dy) {
    const len = Math.hypot(dx, dy);
    const x = Math.round(a.x + (dx / len) * a.r);
    const y = Math.round(a.y + (dy / len) * a.r);
    if (!touching) {
      cmd('input motionevent DOWN ' + a.x + ' ' + a.y);
      touching = true;
    }
    cmd('input motionevent MOVE ' + x + ' ' + y);
  } else if (touching) {
    release();
  }
}

// Spacebar, phone-side fallback path (the page normally sends its own touch,
// which is what makes jump-while-moving and hold-to-jump work). One tap on the
// corner spot above. JUMP_X / JUMP_Y (screen fractions) override it.
function jumpPoints() {
  const { w, h } = screen();
  const fx = parseFloat(process.env.JUMP_X || '');
  const fy = parseFloat(process.env.JUMP_Y || '');
  if (!isNaN(fx) && !isNaN(fy)) return [{ x: Math.round(w * fx), y: Math.round(h * fy) }];
  return layout().jump;
}

function jump() {
  // `input` only ever injects pointer 0, so the stick and the jump button
  // cannot be pressed at the same time. End the stick gesture, tap jump, then
  // grab the stick again: a jump while running keeps running, because Roblox
  // keeps the character's momentum through the jump.
  const wasTouching = touching;
  if (wasTouching) release();
  for (const p of jumpPoints()) {
    cmd('input motionevent DOWN ' + p.x + ' ' + p.y);
    cmd('input motionevent UP ' + p.x + ' ' + p.y);
  }
  if (wasTouching) update();
}

http
  .createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 'no-store');
    const u = new URL(req.url, 'http://localhost');
    if (u.pathname === '/k') {
      const k = (u.searchParams.get('key') || '').toLowerCase();
      const down = u.searchParams.get('down') === '1';
      if (k === 'jump') {
        if (down && !held.jump) {
          held.jump = 1;
          jump();
        } else if (!down) {
          delete held.jump;
        }
      } else if (k.length === 1 && 'wasd'.indexOf(k) !== -1) {
        if (down) held[k] = 1;
        else delete held[k];
        update();
      }
    }
    if (u.pathname === '/state') {
      // Open this in a tab if WASD stops working: it says what was sent and why.
      res.setHeader('Content-Type', 'application/json');
      res.end(
        JSON.stringify({
          rotation,
          screen: screen(),
          anchor: anchor(),
          jump: jumpPoints(),
          held: Object.keys(held),
          touching,
          lastCommand,
          lastError,
        }),
      );
      return;
    }
    res.end('ok');
  })
  .listen(8001, () => console.log('keyd listening on 8001'));
