import crypto from 'node:crypto';
import * as db from './db.js';

const KEY = 'admin_password';

/** The password is stored in the DB only as a salted scrypt hash ("salt:hash", hex). */
export function hasPassword() {
  return db.getSetting(KEY) !== null;
}

export function setPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64);
  db.setSetting(KEY, `${salt.toString('hex')}:${hash.toString('hex')}`);
}

export function verifyPassword(password) {
  const stored = db.getSetting(KEY);
  if (!stored) return false;
  const [salt, hash] = stored.split(':');
  const actual = crypto.scryptSync(password, Buffer.from(salt, 'hex'), 64);
  return crypto.timingSafeEqual(actual, Buffer.from(hash, 'hex'));
}
