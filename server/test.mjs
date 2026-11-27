// Run with: node server/test.mjs
// Boots the real server on a random port against a fake GitHub API, then walks
// the exact flow a visitor's browser follows.
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { mkdtempSync } from 'node:fs';

let failures = 0;
function check(name, cond, extra) {
  if (cond) console.log('ok   ' + name);
  else {
    failures += 1;
    console.log('FAIL ' + name + (extra !== undefined ? '  ' + JSON.stringify(extra) : ''));
  }
}

const listen = (server) => new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));

/* ---- fake GitHub ---- */
let dispatches = [];
let stubStatus = 204;
const gh = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    if (!req.url.includes('/dispatches')) {
      res.writeHead(404);
      return res.end();
    }
    dispatches.push({ url: req.url, auth: req.headers.authorization, body: JSON.parse(body || '{}') });
    res.writeHead(stubStatus, { 'content-type': 'application/json' });
    res.end(stubStatus === 204 ? '' : '{"message":"Bad credentials"}');
  });
});
const ghPort = await listen(gh);

process.env.GITHUB_API_BASE = `http://127.0.0.1:${ghPort}`;
process.env.GITHUB_TOKEN = 'test-token';
process.env.GITHUB_REPO = 'me/wavey';
process.env.GITHUB_REF = 'main';
process.env.WORKFLOW = 'cloud-phone.yml';
process.env.DATA_DIR = mkdtempSync(path.join(os.tmpdir(), 'wavey-'));
process.env.MAX_SESSIONS = '8';

const { createServer } = await import('./index.js');
const app = createServer();
const port = await listen(app);
const base = `http://127.0.0.1:${port}`;

let ipCounter = 0;
async function call(pathname, opts = {}) {
  const res = await fetch(base + pathname, {
    method: opts.method || 'GET',
    headers: {
      'content-type': 'application/json',
      'x-forwarded-for': opts.ip || `10.0.0.${++ipCounter}`,
      'x-forwarded-proto': 'https',
      'x-forwarded-host': 'wavey.example',
    },
    body: opts.body,
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {}
  return { status: res.status, json, text };
}

/* ---- 1. start a session ---- */
let r = await call('/api/session', { method: 'POST', body: '{}', ip: '1.1.1.1' });
check('POST /api/session -> 200', r.status === 200, r.json);
check('session id is 32 hex chars', /^[a-f0-9]{32}$/.test(r.json.id || ''), r.json);
check('starts queued', r.json.status === 'queued', r.json);
const id = r.json.id;

check('one dispatch sent', dispatches.length === 1, dispatches.length);
const sent = dispatches[0].body;
check('dispatch uses the workflow file', dispatches[0].url.includes('/repos/me/wavey/actions/workflows/cloud-phone.yml/dispatches'), dispatches[0].url);
check('dispatch carries the session', sent.inputs.session === id, sent);
check('callback points back at the server', sent.inputs.callback === 'https://wavey.example/api/hook', sent);
check('token is a bearer header', dispatches[0].auth === 'Bearer test-token', dispatches[0].auth);

/* ---- 2. waiting ---- */
r = await call('/api/session/' + id, { ip: '1.1.1.1' });
check('queued session has no url yet', r.json.status === 'queued' && r.json.url === null, r.json);

/* ---- 3. the phone calls back ---- */
const stream = 'https://cat-meet.trycloudflare.com/#!action=stream&udid=emulator-5554';
r = await call('/api/hook', { method: 'POST', body: JSON.stringify({ id, url: stream }), ip: '1.1.1.1' });
check('hook accepted', r.status === 200 && r.json.ok, r.json);

r = await call('/api/session/' + id, { ip: '1.1.1.1' });
check('session is ready', r.json.status === 'ready', r.json);
check('hands back the exact stream link', r.json.url === stream, r.json);
check('session clock is ~5.5h', r.json.leftSec > 19000 && r.json.leftSec <= 19800, r.json);

/* ---- 4. refresh reuses the same phone ---- */
r = await call('/api/session', { method: 'POST', body: '{}', ip: '1.1.1.1' });
check('same visitor gets the same phone', r.json.id === id, r.json);
check('no second dispatch', dispatches.length === 1, dispatches.length);

/* ---- 5. a different visitor gets a different phone ---- */
r = await call('/api/session', { method: 'POST', body: '{}', ip: '2.2.2.2' });
check('second visitor gets a different id', r.json.id && r.json.id !== id, r.json);
check('second visitor triggers another run', dispatches.length === 2, dispatches.length);

/* ---- 6. junk in, junk rejected ---- */
r = await call('/api/hook', { method: 'POST', body: JSON.stringify({ id, url: 'javascript:alert(1)' }) });
check('non-https link refused', r.status === 400, r.json);
r = await call('/api/session/' + 'f'.repeat(32));
check('unknown session is 404', r.status === 404, r.json);
r = await call('/api/session/not-a-real-id');
check('malformed id is 400', r.status === 400, r.json);
r = await call('/api/session/..%2F..%2Fetc');
check('path junk refused', r.status === 400 || r.status === 404, r.status);

/* ---- 7. the site is served ---- */
r = await call('/');
check('site served at /', r.status === 200 && r.text.includes('wavey cloud'), r.status);
check('site has the one button', r.text.includes('Get my phone'));
r = await call('/../package.json');
check('no traversal out of site/', r.status === 404, r.status);

/* ---- 8. capacity ---- */
process.env.MAX_SESSIONS = '1';
r = await call('/api/session', { method: 'POST', body: '{}', ip: '3.3.3.3' });
check('full server says busy', r.status === 503 && r.json.error === 'busy', r.json);

/* ---- 9. bad token leaves no ghost ---- */
process.env.MAX_SESSIONS = '8';
stubStatus = 401;
r = await call('/api/session', { method: 'POST', body: '{}', ip: '4.4.4.4' });
check('bad token -> 502 with GitHub detail', r.status === 502 && r.json.error === 'dispatch_failed', r.json);
stubStatus = 204;
const before = dispatches.length;
r = await call('/api/session', { method: 'POST', body: '{}', ip: '4.4.4.4' });
check('retry after a failure dispatches again', r.status === 200 && dispatches.length === before + 1, r.json);

console.log(failures ? '\n' + failures + ' FAILED' : '\nall server checks passed');
app.close();
gh.close();
process.exit(failures ? 1 : 0);
