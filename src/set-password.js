// Creates or replaces the admin password (stored hashed in the DB).
//   node src/set-password.js              always asks for a new password
//   node src/set-password.js --if-missing asks only when no password exists yet
// Non-interactive: set NEW_ADMIN_PASSWORD.
import { hasPassword, setPassword } from './password.js';
import { askPassword } from './prompt.js';

const MIN_LENGTH = 6;

if (process.argv.includes('--if-missing') && hasPassword()) process.exit(0);

let password = process.env.NEW_ADMIN_PASSWORD;
if (!password) {
  if (!process.stdin.isTTY) {
    console.error('No console available. Set NEW_ADMIN_PASSWORD or run from a terminal.');
    process.exit(1);
  }
  console.log('Set the admin password (it protects deleting results in the admin panel).');
  password = await askPassword(`New admin password (min ${MIN_LENGTH} characters): `);
  if (password !== (await askPassword('Repeat password: '))) {
    console.error('Passwords do not match.');
    process.exit(1);
  }
}
if (password.length < MIN_LENGTH) {
  console.error(`Password must be at least ${MIN_LENGTH} characters.`);
  process.exit(1);
}

setPassword(password);
console.log('Admin password saved.');
