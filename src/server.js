import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as db from './db.js';
import { hasPassword, verifyPassword } from './password.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC_DIR = path.join(ROOT, 'public');
const CONFIG_FILE = path.join(ROOT, 'config.json');

/** config.json: { "port": 3000, "apiKey": "..." }. Missing values are filled in and written back on start. */
function loadConfig() {
  let cfg = {};
  try {
    cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  } catch (e) {
    if (e.code !== 'ENOENT') {
      console.error(`config.json is not valid JSON: ${e.message}`);
      process.exit(1);
    }
  }
  let changed = false;
  if (!cfg.port) {
    cfg.port = 3000;
    changed = true;
  }
  if (!cfg.apiKey) {
    cfg.apiKey = crypto.randomBytes(16).toString('hex');
    changed = true;
  }
  if (changed) fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2) + '\n');
  return cfg;
}

const config = loadConfig();
const PORT = Number(process.env.PORT) || Number(config.port);
const HOST = process.env.HOST || '0.0.0.0';
const API_KEY = String(config.apiKey);

if (!hasPassword()) {
  console.error('Admin password is not set. Run start.bat (or set-password.bat) to create it. The server will not start without it.');
  process.exit(1);
}

const digest = (s) => crypto.createHash('sha256').update(s).digest();
const safeEqual = (a, b) => crypto.timingSafeEqual(digest(a), digest(b));

// Brute-force protection: after FAIL_LIMIT wrong credentials per IP and kind, block that IP for FAIL_WINDOW.
const FAIL_LIMIT = 5;
const FAIL_WINDOW = 60_000;
const failures = new Map();
const MAX_BODY = 64 * 1024;
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.jpg': 'image/jpeg',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

class HttpError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

const MAX_NAME_LENGTH = 64;
const SUGGEST_MIN_LENGTH = 3; // suggestions are offered for names longer than 3 characters

function send(res, status, body, headers = {}) {
  const isJson = typeof body !== 'string' && !Buffer.isBuffer(body);
  const payload = isJson ? JSON.stringify(body) : body;
  res.writeHead(status, {
    'Content-Type': isJson ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(payload);
}

async function readJson(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw new HttpError(413, 'Body too large');
    chunks.push(chunk);
  }
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    if (parsed === null || typeof parsed !== 'object') throw new Error();
    return parsed;
  } catch {
    throw new HttpError(400, 'Invalid JSON');
  }
}

/**
 * `credential` is undefined when the client sent none (not counted as a failed attempt).
 * Sends 401/429 and returns false when access is denied.
 */
function authorize(req, res, kind, credential, verify, message) {
  const id = `${kind}:${req.socket.remoteAddress}`;
  const now = Date.now();
  let f = failures.get(id);
  if (f && now - f.since > FAIL_WINDOW) {
    failures.delete(id);
    f = undefined;
  }
  if (f && f.count >= FAIL_LIMIT) {
    send(res, 429, { error: 'Too many failed attempts. Try again in a minute.' });
    return false;
  }

  if (credential !== undefined && verify(credential)) {
    failures.delete(id);
    return true;
  }
  if (credential !== undefined) failures.set(id, { count: (f?.count ?? 0) + 1, since: f?.since ?? now });
  send(res, 401, { error: message });
  return false;
}

const checkApiKey = (req, res) =>
  authorize(req, res, 'apikey', req.headers['x-api-key'], (key) => safeEqual(key, API_KEY), 'Invalid API key');

/** The admin password is sent URL-encoded in X-Admin-Password (only needed for moderation). */
function checkAdminPassword(req, res) {
  let password;
  const header = req.headers['x-admin-password'];
  if (header !== undefined) {
    try {
      password = decodeURIComponent(header);
    } catch {
      password = '';
    }
  }
  return authorize(req, res, 'admin', password, verifyPassword, 'Wrong or missing admin password');
}

function serveStatic(res, pathname) {
  const rel = pathname === '/admin' ? 'index.html' : pathname.slice('/admin/'.length) || 'index.html';
  const file = path.resolve(PUBLIC_DIR, 'admin', rel);
  if (!file.startsWith(path.join(PUBLIC_DIR, 'admin')) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    return send(res, 404, 'Not found');
  }
  res.writeHead(200, {
    'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
    'Cache-Control': 'no-cache',
  });
  fs.createReadStream(file).pipe(res);
}

function parseRunResult(body) {
  const score = Number(body.Score);
  const duration = Number(body.Duration);
  const barrels = Number(body.BarrelsCollected);
  if (![score, duration, barrels].every(Number.isFinite) || duration < 0 || barrels < 0) {
    throw new HttpError(400, 'Score, Duration and BarrelsCollected must be numbers (Duration, BarrelsCollected >= 0)');
  }
  return { score: Math.round(score), duration, barrelsCollected: Math.round(barrels) };
}

function nameInfo(name) {
  const available = !db.isNameTaken(name);
  const suggestion = !available && name.length >= SUGGEST_MIN_LENGTH ? db.suggestName(name) : null;
  return { name, available, suggestion };
}

async function handle(req, res) {
  const { pathname: raw } = new URL(req.url, 'http://localhost');
  const p = raw.length > 1 ? raw.replace(/\/+$/, '') : raw;
  const m = req.method;

  if (p === '/' && m === 'GET') return send(res, 302, '', { Location: '/admin/' });

  // Game client API (requires X-Api-Key)
  if (p === '/api/results' && (m === 'GET' || m === 'POST')) {
    if (!checkApiKey(req, res)) return;
    if (m === 'GET') return send(res, 200, { results: db.listResults() });
    const run = parseRunResult(await readJson(req));
    if (!db.submitResult(run)) {
      return send(res, 409, { error: 'No active session. Register a session in the admin panel.', results: db.listResults() });
    }
    return send(res, 200, { results: db.listResults() });
  }

  // Admin panel: open, only deleting results asks for the admin password.
  if (p === '/admin' || p.startsWith('/admin/')) return m === 'GET' ? serveStatic(res, p) : send(res, 405, 'Method not allowed');

  if (p === '/api/admin/results' && m === 'GET') return send(res, 200, { results: db.listResults() });
  if (p === '/api/admin/session' && m === 'GET') return send(res, 200, { session: db.getActiveSession() });
  if (p === '/api/admin/session' && m === 'POST') {
    const name = db.cleanName((await readJson(req)).name);
    if (!name || name.length > MAX_NAME_LENGTH) throw new HttpError(400, `Name must be 1-${MAX_NAME_LENGTH} characters`);
    if (db.isNameTaken(name)) throw new HttpError(409, 'Name is already taken', nameInfo(name));
    return send(res, 201, { session: db.startSession(name) });
  }
  if (p === '/api/admin/name-check' && m === 'GET') {
    const name = db.cleanName(new URL(req.url, 'http://localhost').searchParams.get('name'));
    if (!name || name.length > MAX_NAME_LENGTH) throw new HttpError(400, `Name must be 1-${MAX_NAME_LENGTH} characters`);
    return send(res, 200, nameInfo(name));
  }
  if (p === '/api/admin/session' && m === 'DELETE') return send(res, 200, { cancelled: db.cancelSession() });

  const del = p.match(/^\/api\/admin\/results\/(\d+)$/);
  if (del && m === 'DELETE') {
    if (!checkAdminPassword(req, res)) return;
    return db.deleteResult(Number(del[1])) ? send(res, 200, { ok: true }) : send(res, 404, { error: 'Not found' });
  }

  send(res, 404, { error: 'Not found' });
}

http
  .createServer((req, res) => {
    handle(req, res).catch((e) => {
      if (e instanceof HttpError) return send(res, e.status, { error: e.message, ...e.extra });
      console.error(e);
      send(res, 500, { error: 'Internal error' });
    });
  })
  .listen(PORT, HOST, () => {
    fs.writeFileSync(db.pidFile, String(process.pid));
    const removePid = () => fs.rmSync(db.pidFile, { force: true });
    process.on('exit', removePid);
    for (const signal of ['SIGINT', 'SIGTERM', 'SIGBREAK']) process.on(signal, () => process.exit(0));

    console.log(`Burning Labyrinth server started on port ${PORT}`);
    console.log(`  Admin panel:  http://localhost:${PORT}/admin/`);
    console.log(`  Game API key: see config.json ("apiKey") -> "Api Key" of the UE component`);
    for (const list of Object.values(os.networkInterfaces())) {
      for (const i of list ?? []) {
        if (i.family === 'IPv4' && !i.internal) console.log(`  From the LAN: http://${i.address}:${PORT}/   <- use this as ServerUrl in UE`);
      }
    }
  });
