// Full reset: after the admin password is confirmed, stops the running server and deletes the whole database
// (results, sessions and the admin password). The next start.bat starts from scratch.
// config.json (port and game API key) is kept.
// Non-interactive (testing): set RESET_ADMIN_PASSWORD and pass --yes.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import * as db from './db.js';
import { hasPassword, verifyPassword } from './password.js';
import { ask, askPassword } from './prompt.js';

const interactive = process.stdin.isTTY;
if (!interactive && !process.env.RESET_ADMIN_PASSWORD && hasPassword()) {
  console.error('No console available.');
  process.exit(1);
}

// 1. Password (nothing to check if it was never set)
if (hasPassword()) {
  let ok = false;
  for (let attempt = 1; attempt <= 3 && !ok; attempt++) {
    const password = interactive ? await askPassword('Admin password: ') : process.env.RESET_ADMIN_PASSWORD;
    ok = verifyPassword(password);
    if (!ok) console.error('Wrong password.');
    if (!interactive) break;
  }
  if (!ok) process.exit(1);
}

// 2. Confirmation
if (interactive || !process.argv.includes('--yes')) {
  const { results, sessions } = db.countAll();
  console.log(`This will stop the server and permanently delete the whole database: ${results} result(s), ${sessions} session(s) and the admin password.`);
  if ((await ask('Type YES to continue: ')).trim() !== 'YES') {
    console.log('Cancelled. Nothing was deleted.');
    process.exit(1);
  }
}

db.closeDb();

// 3. Stop the running server (only a process whose command line is really our server.js)
function runningServerPid() {
  let pid;
  try {
    pid = Number(fs.readFileSync(db.pidFile, 'utf8'));
  } catch {
    return null;
  }
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    const cmd = execFileSync(
      'powershell',
      ['-NoProfile', '-Command', `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`],
      { encoding: 'utf8' },
    );
    return /server\.js/i.test(cmd) ? pid : null;
  } catch {
    return null;
  }
}

const pid = runningServerPid();
if (pid) {
  process.kill(pid);
  for (let i = 0; i < 50; i++) {
    try {
      process.kill(pid, 0);
    } catch {
      break; // gone
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  console.log(`Server (pid ${pid}) stopped.`);
}
fs.rmSync(db.pidFile, { force: true });

// 4. Delete the database files
// Windows may release the files a moment after the process is gone, so retry for a few seconds.
for (let attempt = 1; ; attempt++) {
  try {
    for (const file of db.dbFiles) fs.rmSync(file, { force: true });
    break;
  } catch (e) {
    if (attempt >= 30) {
      console.error(`Could not delete the database (${e.code}). The server is probably still running: close its window and run this again.`);
      process.exit(1);
    }
    await new Promise((r) => setTimeout(r, 100));
  }
}
console.log('Database deleted. The next start.bat will ask for a new admin password.');
