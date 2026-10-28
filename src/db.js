import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dataDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data');
const dbFile = process.env.DB_FILE || path.join(dataDir, 'data.db');
fs.mkdirSync(path.dirname(dbFile), { recursive: true });

export { dbFile };
/** The running server stores its process id here so that reset-db can stop it. */
export const pidFile = path.join(path.dirname(dbFile), 'server.pid');
/** Files that make up the database; deleting them resets the server to a clean state. */
export const dbFiles = [dbFile, `${dbFile}-wal`, `${dbFile}-shm`];

const db = new DatabaseSync(dbFile);
export const closeDb = () => db.close();
db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS sessions (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT NOT NULL,
    status     TEXT NOT NULL DEFAULT 'active',   -- active | used | cancelled
    created_at TEXT NOT NULL,
    used_at    TEXT
  );
  CREATE UNIQUE INDEX IF NOT EXISTS one_active_session ON sessions(status) WHERE status = 'active';
  CREATE TABLE IF NOT EXISTS results (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id       INTEGER REFERENCES sessions(id),
    nickname         TEXT NOT NULL,
    score            INTEGER NOT NULL,
    duration         REAL NOT NULL,
    barrels_collected INTEGER NOT NULL,
    created_at       TEXT NOT NULL
  );
`);

db.exec(`CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);

const now = () => new Date().toISOString();

export function getSetting(key) {
  return db.prepare(`SELECT value FROM settings WHERE key = ?`).get(key)?.value ?? null;
}

export function setSetting(key, value) {
  db.prepare(`INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(key, value);
}

const toSession = (r) => (r ? { Id: r.id, Name: r.name, CreatedAt: r.created_at } : null);

export function countAll() {
  return {
    results: db.prepare(`SELECT COUNT(*) AS n FROM results`).get().n,
    sessions: db.prepare(`SELECT COUNT(*) AS n FROM sessions`).get().n,
  };
}

const MAX_NAME_LENGTH = 64;

/** Trims and collapses whitespace; this is the form that is stored. */
export const cleanName = (name) => String(name ?? '').normalize('NFKC').trim().replace(/\s+/g, ' ');

/** Names are compared ignoring case and the difference between "ё" and "е". */
const nameKey = (name) => cleanName(name).toLowerCase().replace(/ё/g, 'е');

const takenKeys = () => new Set(db.prepare(`SELECT nickname FROM results`).all().map((r) => nameKey(r.nickname)));

/** One result per name: a name is taken as soon as a result with it exists (deleting the result frees it). */
export function isNameTaken(name) {
  return takenKeys().has(nameKey(name));
}

/**
 * First free "<base>_<n>". "Катя" -> "Катя_1"; a name that already ends with _N continues from N+1
 * ("Катя_1" -> "Катя_2"), skipping any names that are taken too.
 */
export function suggestName(name) {
  const taken = takenKeys();
  const m = cleanName(name).match(/^(.+?)_(\d+)$/);
  const base = m ? m[1] : cleanName(name);
  for (let n = m ? Number(m[2]) + 1 : 1; ; n++) {
    const suffix = `_${n}`;
    const candidate = base.slice(0, MAX_NAME_LENGTH - suffix.length).trimEnd() + suffix;
    if (!taken.has(nameKey(candidate))) return candidate;
  }
}

export function getActiveSession() {
  return toSession(db.prepare(`SELECT * FROM sessions WHERE status = 'active'`).get());
}

export function startSession(name) {
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare(`UPDATE sessions SET status = 'cancelled' WHERE status = 'active'`).run();
    const ts = now();
    const info = db.prepare(`INSERT INTO sessions (name, created_at) VALUES (?, ?)`).run(name, ts);
    db.exec('COMMIT');
    return { Id: Number(info.lastInsertRowid), Name: name, CreatedAt: ts };
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

export function cancelSession() {
  return db.prepare(`UPDATE sessions SET status = 'cancelled' WHERE status = 'active'`).run().changes > 0;
}

export function listResults() {
  return db
    .prepare(
      `SELECT id, nickname, score, duration, barrels_collected, created_at
       FROM results ORDER BY score DESC, duration ASC, id ASC`,
    )
    .all()
    .map((r) => ({
      Id: r.id,
      Nickname: r.nickname,
      Score: r.score,
      Duration: r.duration,
      BarrelsCollected: r.barrels_collected,
      Timestamp: r.created_at,
    }));
}

export function deleteResult(id) {
  return db.prepare(`DELETE FROM results WHERE id = ?`).run(id).changes > 0;
}

/** Stores the result under the active session's name and closes the session. Returns false if there is no active session. */
export function submitResult({ score, duration, barrelsCollected }) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const session = db.prepare(`SELECT * FROM sessions WHERE status = 'active'`).get();
    if (!session) {
      db.exec('ROLLBACK');
      return false;
    }
    const ts = now();
    db.prepare(
      `INSERT INTO results (session_id, nickname, score, duration, barrels_collected, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(session.id, session.name, score, duration, barrelsCollected, ts);
    db.prepare(`UPDATE sessions SET status = 'used', used_at = ? WHERE id = ?`).run(ts, session.id);
    db.exec('COMMIT');
    return true;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}
