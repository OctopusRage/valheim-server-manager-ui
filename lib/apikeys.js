// Secret keys for the /hook endpoints (scripts, Discord bots, phone shortcuts…).
// Only a SHA-256 of each key is stored, in DATA_DIR/apikeys.json; the plaintext
// is shown once when the key is created.
import { randomBytes, createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { DATA_DIR } from './store.js';

const FILE = path.join(DATA_DIR, 'apikeys.json');
export const ACTIONS = ['status', 'start', 'stop', 'restart', 'reload'];

const sha = (s) => createHash('sha256').update(s).digest('hex');

async function readAll() {
  try {
    return JSON.parse(await fs.readFile(FILE, 'utf8'));
  } catch (e) {
    if (e.code === 'ENOENT') return [];
    throw e;
  }
}

async function writeAll(keys) {
  await fs.mkdir(DATA_DIR, { recursive: true });
  const tmp = FILE + '.tmp';
  await fs.writeFile(tmp, JSON.stringify(keys, null, 2), { mode: 0o600 });
  await fs.rename(tmp, FILE);
}

const view = ({ hash, ...k }) => k;

export async function list() {
  return (await readAll()).map(view);
}

// servers: [] = every server; actions: subset of ACTIONS
export async function create({ name, servers = [], actions = ACTIONS }) {
  name = String(name || '').trim();
  if (!name || name.length > 60) throw Object.assign(new Error('Key name is required (max 60 chars)'), { status: 400 });
  actions = [...new Set(actions)].filter((a) => ACTIONS.includes(a));
  if (!actions.length) throw Object.assign(new Error('Pick at least one allowed action'), { status: 400 });
  const secret = `vhm_${randomBytes(24).toString('base64url')}`;
  const key = {
    id: randomBytes(6).toString('hex'),
    name,
    prefix: secret.slice(0, 10),
    hash: sha(secret),
    servers: [...new Set(servers.map(String))],
    actions,
    createdAt: new Date().toISOString(),
    lastUsedAt: null,
  };
  const keys = await readAll();
  keys.push(key);
  await writeAll(keys);
  return { ...view(key), secret };
}

export async function revoke(id) {
  const keys = await readAll();
  const next = keys.filter((k) => k.id !== id);
  if (next.length === keys.length) throw Object.assign(new Error('No such key'), { status: 404 });
  await writeAll(next);
}

// Returns the key record if `secret` may run `action` on `serverId`, else null.
// Also returns why not, so the caller can answer 401 vs 403.
export async function check(secret, serverId, action) {
  if (!secret) return { ok: false, status: 401 };
  const keys = await readAll();
  const h = sha(secret);
  const key = keys.find((k) => k.hash === h);
  if (!key) return { ok: false, status: 401 };
  if (key.servers.length && !key.servers.includes(serverId)) return { ok: false, status: 403, error: 'Key not allowed for this server' };
  if (!key.actions.includes(action)) return { ok: false, status: 403, error: `Key not allowed to ${action}` };
  key.lastUsedAt = new Date().toISOString();
  await writeAll(keys);
  return { ok: true, key: view(key) };
}
