// Wavey Cloud server (Render).
//
// Serves the site and the session API. No dependencies, no database: sessions
// live in memory and are mirrored to a JSON file so a restart does not lose
// them. One visitor = one workflow run = one private phone.
//
// Env: PORT, GITHUB_TOKEN, GITHUB_REPO, GITHUB_REF, WORKFLOW, MAX_SESSIONS,
//      GITHUB_API_BASE (tests), DATA_DIR.

import http from 'node:http';
import crypto from 'node:crypto';
import { createReadStream, existsSync, mkdirSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const SITE = path.join(ROOT, 'site');
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, 'data');
const STORE = path.join(DATA_DIR, 'sessions.json');

const TTL_SEC = 19800; // matches the workflow's keep-alive sleep
const MAX_AGE_SEC = 86400;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

let sessions = loadSessions();

/* ------------------------------------------------------------------ server */

export function createServer() {
  return http.createServer((req, res) => {
    handle(req, res).catch((error) => {
      console.error('request failed', error);
      sendJson(res, 500, { error: 'server_error', detail: String(error).slice(0, 200) });
    });
  });
}

async function handle(req, res) {
  const url = new URL(req.url, 'http://localhost');

  if (url.pathname === '/api/health') return sendJson(res, 200, { ok: true });
  if (url.pathname === '/api/session' && req.method === 'POST') return createSession(req, res);
  if (url.pathname.startsWith('/api/session/') && req.method === 'GET') {
    return readSession(res, url.pathname.split('/').pop());
  }
  if (url.pathname === '/api/hook' && req.method === 'POST') return registerPhone(req, res);

  if (req.method !== 'GET' && req.method !== 'HEAD') return sendJson(res, 405, { error: 'method_not_allowed' });
  return serveStatic(req, res, url.pathname);
}

/* ---------------------------------------------------------------- sessions */

async function createSession(req, res) {
  const now = Math.floor(Date.now() / 1000);
  const ip = ipHash(req);
  const max = parseInt(process.env.MAX_SESSIONS || '8', 10);

  const mine = [...sessions.values()].find(
    (s) => s.ip === ip && (s.status === 'queued' || s.status === 'ready') && now - s.createdAt < TTL_SEC,
  );
  if (mine) return sendJson(res, 200, publicSession(mine, now));

  const active = [...sessions.values()].filter(
    (s) => (s.status === 'queued' || s.status === 'ready') && now - s.createdAt < TTL_SEC,
  ).length;
  if (active >= max) {
    return sendJson(res, 503, { error: 'busy', message: 'All cloud phones are in use. Try again in a few minutes.' });
  }

  const id = crypto.randomBytes(16).toString('hex');
  const record = { id, ip, status: 'queued', url: null, createdAt: now, updatedAt: now };
  sessions.set(id, record);
  saveSessions();

  const repo = process.env.GITHUB_REPO;
  const token = process.env.GITHUB_TOKEN;
  if (!repo || !token) {
    sessions.delete(id);
    saveSessions();
    return sendJson(res, 500, { error: 'not_configured', message: 'Add GITHUB_REPO and GITHUB_TOKEN in Render → Environment.' });
  }

  const api = process.env.GITHUB_API_BASE || 'https://api.github.com';
  const workflow = process.env.WORKFLOW || 'cloud-phone.yml';
  const origin = originOf(req);

  let dispatch;
  try {
    dispatch = await fetch(`${api}/repos/${repo}/actions/workflows/${encodeURIComponent(workflow)}/dispatches`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/vnd.github+json',
        'content-type': 'application/json',
        'user-agent': 'wavey-cloud',
      },
      body: JSON.stringify({
        ref: process.env.GITHUB_REF || 'main',
        inputs: { session: id, callback: `${origin}/api/hook` },
      }),
    });
  } catch (error) {
    sessions.delete(id);
    saveSessions();
    return sendJson(res, 502, { error: 'dispatch_failed', detail: 'Could not reach GitHub: ' + String(error.message || error) });
  }

  if (!dispatch.ok) {
    const detail = (await dispatch.text().catch(() => '')).slice(0, 300);
    sessions.delete(id);
    saveSessions();
    return sendJson(res, 502, { error: 'dispatch_failed', status: dispatch.status, detail });
  }

  console.log(`session ${id}: dispatched ${repo}/${workflow}`);
  return sendJson(res, 200, publicSession(record, now));
}

function readSession(res, id) {
  if (!id || !/^[a-z0-9]{8,64}$/i.test(id)) return sendJson(res, 400, { error: 'bad_id' });
  const row = sessions.get(id);
  if (!row) return sendJson(res, 404, { error: 'not_found' });
  return sendJson(res, 200, publicSession(row, Math.floor(Date.now() / 1000)));
}

// The workflow posts here once its tunnel is up.
async function registerPhone(req, res) {
  let body;
  try {
    body = JSON.parse(await readBody(req));
  } catch {
    return sendJson(res, 400, { error: 'bad_json' });
  }

  const id = String(body.id || '');
  const url = String(body.url || '');
  if (!/^[a-z0-9]{8,64}$/i.test(id)) return sendJson(res, 400, { error: 'bad_id' });
  if (!/^https:\/\/[a-z0-9.-]+\//i.test(url)) return sendJson(res, 400, { error: 'bad_url' });

  const row = sessions.get(id);
  if (!row) return sendJson(res, 404, { error: 'not_found' });
  if (row.status === 'queued') {
    row.status = 'ready';
    row.url = url;
    row.updatedAt = Math.floor(Date.now() / 1000);
    saveSessions();
    console.log(`session ${id}: phone is live`);
  }
  return sendJson(res, 200, { ok: true });
}

function publicSession(row, now) {
  const ageSec = Math.max(0, now - row.createdAt);
  let status = row.status;
  if (status === 'ready' && ageSec > TTL_SEC) status = 'expired';
  return {
    id: row.id,
    status,
    url: status === 'ready' ? row.url : null,
    ageSec,
    leftSec: status === 'ready' ? Math.max(0, TTL_SEC - ageSec) : null,
  };
}

/* ------------------------------------------------------------------ static */

function serveStatic(req, res, pathname) {
  const rel = decodeURIComponent(pathname === '/' ? '/index.html' : pathname);
  const file = path.join(SITE, path.normalize(rel).replace(/^([/\\])+/, ''));
  if (!file.startsWith(SITE) || !existsSync(file) || !statSync(file).isFile()) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    return res.end('not found');
  }
  const ext = path.extname(file).toLowerCase();
  res.writeHead(200, {
    'content-type': MIME[ext] || 'application/octet-stream',
    'cache-control': ext === '.html' ? 'no-store' : 'public, max-age=300',
  });
  if (req.method === 'HEAD') return res.end();
  createReadStream(file).pipe(res);
}

/* ------------------------------------------------------------------ helpers */

function sendJson(res, status, data) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(data));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > 1_000_000) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function ipHash(req) {
  const forwarded = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  const ip = forwarded || req.socket.remoteAddress || 'unknown';
  return crypto.createHash('sha256').update(`${ip}|${process.env.IP_SALT || 'wavey-cloud'}`).digest('hex').slice(0, 24);
}

function originOf(req) {
  if (process.env.PUBLIC_ORIGIN) return process.env.PUBLIC_ORIGIN.replace(/\/$/, '');
  const proto = String(req.headers['x-forwarded-proto'] || 'https').split(',')[0];
  const host = String(req.headers['x-forwarded-host'] || req.headers.host);
  return `${proto}://${host}`;
}

function loadSessions() {
  try {
    const raw = JSON.parse(readFileSync(STORE, 'utf8'));
    const now = Math.floor(Date.now() / 1000);
    const fresh = raw.filter((row) => now - row.createdAt < MAX_AGE_SEC);
    return new Map(fresh.map((row) => [row.id, row]));
  } catch {
    return new Map();
  }
}

function saveSessions() {
  const now = Math.floor(Date.now() / 1000);
  for (const [id, row] of sessions) {
    if (now - row.createdAt > MAX_AGE_SEC) sessions.delete(id);
  }
  try {
    mkdirSync(DATA_DIR, { recursive: true });
    writeFileSync(STORE, JSON.stringify([...sessions.values()]));
  } catch (error) {
    console.error('could not save sessions', error);
  }
}

/* -------------------------------------------------------------------- boot */

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = parseInt(process.env.PORT || '3000', 10);
  createServer().listen(port, '0.0.0.0', () => {
    console.log(`wavey cloud on :${port}  (repo: ${process.env.GITHUB_REPO || 'not set'})`);
  });
}
