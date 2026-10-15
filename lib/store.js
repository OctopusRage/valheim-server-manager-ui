// Persistent server definitions. Each server lives in DATA_DIR/servers/<id>/:
//   server.json  – definition (settings, env vars, installed mods)
//   server.env   – generated docker --env-file (0600, holds the password)
//   config/      – mounted at /config (worlds, backups, mod configs)
//   data/        – mounted at /opt/valheim (server install, ~1 GB)
import fs from 'node:fs/promises';
import path from 'node:path';

export const DATA_DIR = path.resolve(process.env.DATA_DIR || './data');
const SERVERS_DIR = path.join(DATA_DIR, 'servers');

export const ID_RE = /^[a-z0-9][a-z0-9-]{0,30}$/;

// Variables the UI manages through dedicated fields; never accepted as custom env.
export const MANAGED_ENV = new Set([
  'SERVER_NAME', 'WORLD_NAME', 'SERVER_PORT', 'SERVER_PASS', 'SERVER_PASS_FILE',
  'SERVER_PUBLIC', 'SERVER_ARGS', 'CROSSPLAY', 'BEPINEX', 'VALHEIM_PLUS', 'PUID', 'PGID',
]);

export const serverDir = (id) => path.join(SERVERS_DIR, id);
export const configDir = (id) => path.join(serverDir(id), 'config');
export const installDir = (id) => path.join(serverDir(id), 'data');

export function modRoot(server) {
  if (server.modFramework === 'bepinex') return path.join(configDir(server.id), 'bepinex');
  if (server.modFramework === 'valheimplus') return path.join(configDir(server.id), 'valheimplus');
  return null;
}

export async function list() {
  await fs.mkdir(SERVERS_DIR, { recursive: true });
  const ids = (await fs.readdir(SERVERS_DIR, { withFileTypes: true }))
    .filter((d) => d.isDirectory() && ID_RE.test(d.name)).map((d) => d.name);
  const servers = [];
  for (const id of ids) {
    const s = await get(id);
    if (s) servers.push(s);
  }
  return servers.sort((a, b) => a.port - b.port);
}

export async function get(id) {
  if (!ID_RE.test(id)) return null;
  try {
    return JSON.parse(await fs.readFile(path.join(serverDir(id), 'server.json'), 'utf8'));
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
}

export async function save(server) {
  const dir = serverDir(server.id);
  await fs.mkdir(path.join(dir, 'config', 'worlds_local'), { recursive: true });
  await fs.mkdir(path.join(dir, 'data'), { recursive: true });
  const tmp = path.join(dir, 'server.json.tmp');
  await fs.writeFile(tmp, JSON.stringify(server, null, 2));
  await fs.rename(tmp, path.join(dir, 'server.json'));
  await fs.writeFile(path.join(dir, 'server.env'), envFile(server), { mode: 0o600 });
  await fs.chmod(path.join(dir, 'server.env'), 0o600);
}

// Full environment passed to the container.
export function containerEnv(server) {
  const env = {
    SERVER_NAME: server.serverName,
    WORLD_NAME: server.worldName,
    SERVER_PORT: String(server.port),
    SERVER_PASS: server.password,
    SERVER_PUBLIC: String(server.public),
    SERVER_ARGS: serverArgs(server),
    CROSSPLAY: String(server.crossplay),
    BEPINEX: String(server.modFramework === 'bepinex'),
    VALHEIM_PLUS: String(server.modFramework === 'valheimplus'),
    PUID: String(process.getuid()),
    PGID: String(process.getgid()),
  };
  for (const [k, v] of Object.entries(server.env || {})) {
    if (!MANAGED_ENV.has(k)) env[k] = v;
  }
  return env;
}

// World preset / modifiers / keys plus free-form extra args -> SERVER_ARGS.
export function serverArgs(server) {
  const w = server.world || {};
  const args = [];
  if (w.preset) args.push('-preset', w.preset);
  for (const [k, v] of Object.entries(w.modifiers || {})) if (v) args.push('-modifier', k, v);
  for (const k of w.keys || []) args.push('-setkey', k);
  if (server.extraArgs) args.push(server.extraArgs);
  return args.join(' ');
}

function envFile(server) {
  return Object.entries(containerEnv(server)).map(([k, v]) => `${k}=${v}`).join('\n') + '\n';
}

export async function remove(id) {
  await fs.rm(serverDir(id), { recursive: true, force: true });
}
