// Usage: npm run set-password   (prompts; or pipe it: echo 'pw' | npm run set-password)
import { createInterface } from 'node:readline';
import { setPassword, MIN_PASSWORD } from './lib/auth.js';
import { DATA_DIR } from './lib/store.js';

const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: process.stdin.isTTY });
const ask = (q) => new Promise((resolve) => {
  if (process.stdin.isTTY) {
    // hide typed characters
    rl._writeToOutput = (s) => { if (s.includes(q)) rl.output.write(s); };
  }
  rl.question(q, (a) => { if (process.stdin.isTTY) rl.output.write('\n'); resolve(a); });
});

const pw = await ask(`New admin password (min ${MIN_PASSWORD} chars): `);
if (process.stdin.isTTY && (await ask('Repeat: ')) !== pw) {
  console.error('Passwords do not match');
  process.exit(1);
}
rl.close();
try {
  await setPassword(pw);
  console.log(`Saved to ${DATA_DIR}/auth.json. Restart the manager to log out existing sessions.`);
} catch (e) {
  console.error(e.message);
  process.exit(1);
}
