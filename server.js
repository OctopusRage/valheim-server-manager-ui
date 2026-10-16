import express from 'express';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import AdmZip from 'adm-zip';
import * as store from './lib/store.js';
import * as docker from './lib/docker.js';
import * as mods from './lib/mods.js';
import * as auth from './lib/auth.js';
import * as tailscale from './lib/tailscale.js';
import * as apikeys from './lib/apikeys.js';
import * as modpack from './lib/modpack.js';
import { sharePage } from './lib/sharepage.js';
import { worldInfo } from './lib/worldinfo.js';
import { ENV_CATALOG, WORLD_PRESETS, WORLD_MODIFIERS, WORLD_KEYS } from './lib/envcatalog.js';

const HOST = process.env.HOST || '127.0.0.1';
const PORT = Number(process.env.PORT || 8790);
const BASE_GAME_PORT = 2456;

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(import.meta.dirname, 'public')));

app.use('/api', auth.sameOrigin);
app.get('/api/auth/status', (req, res, next) => auth.status(req, res).catch(next));
app.post('/api/auth/setup', (req, res, next) => auth.setup(req, res).catch(next));
app.post('/api/auth/login', (req, res, next) => auth.login(req, res).catch(next));
app.post('/api/auth/logout', auth.logout);
app.use('/api', auth.requireAuth);
app.post('/api/auth/password', (req, res, next) => auth.changePassword(req, res).catch(next));


// --- helpers ---------------------------------------------------------------

const fail = (status, message) => Object.assign(new Error(message), { status });
const wrap = (fn) => (req, res, next) => fn(req, res).catch(next);

// Serialise mutations per server so concurrent requests can't clobber server.json.
const locks = new Map();
function withLock(id, fn) {
  const prev = locks.get(id) || Promise.resolve();
  const run = prev.then(fn, fn);
  locks.set(id, run.catch(() => {}));
  return run;
}

// Long docker operations run in the background; the UI polls status.
const jobs = new Map(); // id -> { action, since }
const lastError = new Map(); // id -> { action, message, at }
function runJob(id, action, fn) {
  if (jobs.has(id)) throw fail(409, `Busy: ${jobs.get(id).action} in progress`);
  jobs.set(id, { action, since: Date.now() });
  lastError.delete(id);
  // resolves to null on success or the error message, never rejects
  return withLock(id, fn)
    .then(() => null, (e) => {
      lastError.set(id, { action, message: e.message, at: Date.now() });
      return e.message;
    })
    .finally(() => jobs.delete(id));
}

async function load(id) {
  const s = await store.get(id);
  if (!s) throw fail(404, `No server "${id}"`);
  return s;
}

const seedOf = (s) => worldInfo(path.join(store.configDir(s.id), 'worlds_local'), s.worldName).catch(() => null);

function publicView(s, st, statsById = {}, seed = null) {
  const { password, ...rest } = s;
  return {
    ...rest,
    hasPassword: Boolean(password),
    serverArgs: store.serverArgs(s),
    container: st ? { state: st.state, status: st.status } : null,
    pendingChanges: st ? st.hash !== docker.runHash(s) : false,
    busy: jobs.get(s.id) || null,
    lastError: lastError.get(s.id) || null,
    stats: statsById[s.id] || null,
    seed: seed && { name: seed.seedName, value: seed.seed },
  };
}

const slug = (name) => name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24) || 'world';

function overlaps(a, b) {
  return Math.abs(a - b) < 3; // each server uses port..port+2
}

async function suggestPort(servers) {
  for (let p = BASE_GAME_PORT; p < 65000; p += 10) {
    if (!servers.some((s) => overlaps(s.port, p))) return p;
  }
  throw fail(500, 'No free port range');
}

// Validate + normalise user-editable fields onto `target`.
function applyFields(target, body, servers) {
  const str = (v) => (v == null ? undefined : String(v).trim());
  const noNewline = (k, v) => { if (/[\r\n]/.test(v)) throw fail(400, `${k} must be a single line`); return v; };

  if (body.serverName !== undefined) {
    const v = noNewline('Server name', str(body.serverName));
    if (!v || v.length > 64) throw fail(400, 'Server name is required (max 64 chars)');
    target.serverName = v;
  }
  if (body.worldName !== undefined) {
    const v = str(body.worldName);
    if (!/^[A-Za-z0-9_\- ]{1,40}$/.test(v)) throw fail(400, 'World name: letters, digits, space, _ or - (max 40)');
    target.worldName = v;
  }
  if (body.password !== undefined && body.password !== '') {
    const v = noNewline('Password', String(body.password));
    if (v.length < 5) throw fail(400, 'Password must be at least 5 characters');
    target.password = v;
  }
  if (!target.password) throw fail(400, 'Password is required (min 5 characters)');
  if (target.serverName.includes(target.password)) throw fail(400, 'Valheim refuses passwords that appear in the server name');
  if (body.port !== undefined) {
    const v = Number(body.port);
    if (!Number.isInteger(v) || v < 1024 || v > 65000) throw fail(400, 'Port must be 1024–65000');
    const clash = servers.find((s) => s.id !== target.id && overlaps(s.port, v));
    if (clash) throw fail(400, `Port ${v}-${v + 2} overlaps "${clash.serverName}" (${clash.port}-${clash.port + 2})`);
    target.port = v;
  }
  if (body.public !== undefined) target.public = Boolean(body.public);
  if (body.crossplay !== undefined) target.crossplay = Boolean(body.crossplay);
  if (body.modFramework !== undefined) {
    if (!['none', 'bepinex', 'valheimplus'].includes(body.modFramework)) throw fail(400, 'Unknown mod framework');
    if (target.modFramework && target.modFramework !== body.modFramework && Object.keys(target.mods || {}).length) {
      throw fail(400, 'Remove installed mods before switching mod framework');
    }
    target.modFramework = body.modFramework;
  }
  if (body.world !== undefined) {
    const w = body.world || {};
    const world = { preset: '', modifiers: {}, keys: [] };
    if (w.preset) {
      if (!WORLD_PRESETS.includes(w.preset)) throw fail(400, `Unknown preset ${w.preset}`);
      world.preset = w.preset;
    }
    for (const [k, v] of Object.entries(w.modifiers || {})) {
      if (!v) continue;
      if (!WORLD_MODIFIERS[k]?.includes(v)) throw fail(400, `Unknown modifier ${k}=${v}`);
      world.modifiers[k] = v;
    }
    for (const k of w.keys || []) {
      if (!WORLD_KEYS.includes(k)) throw fail(400, `Unknown world key ${k}`);
      world.keys.push(k);
    }
    target.world = world;
  }
  if (!target.worldName) throw fail(400, 'World name is required');
  if (body.extraArgs !== undefined) target.extraArgs = noNewline('Extra args', str(body.extraArgs) || '');
  if (body.env !== undefined) {
    const env = {};
    for (const [k, v] of Object.entries(body.env || {})) {
      if (!/^[A-Z_][A-Z0-9_]*$/.test(k)) throw fail(400, `Invalid variable name ${k}`);
      if (store.MANAGED_ENV.has(k)) throw fail(400, `${k} is set through its own field`);
      env[k] = noNewline(k, String(v ?? ''));
    }
    target.env = env;
  }
}

// Make sure the container matches the current definition, recreating it if not.
async function ensureContainer(s, st, force = false) {
  if (st && !force && st.hash === docker.runHash(s)) return;
  if (st) {
    if (st.state === 'running') await docker.stop(s.id);
    await docker.removeContainer(s.id);
  }
  // pre-create dirs as us, so the manager can still write mods/configs into them
  if (store.modRoot(s)) await fs.mkdir(path.join(store.modRoot(s), 'plugins'), { recursive: true });
  await docker.create(s);
}

// --- API -------------------------------------------------------------------

app.get('/api/meta', wrap(async (req, res) => {
  const servers = await store.list();
  const ips = Object.values(os.networkInterfaces()).flat()
    .filter((i) => i && i.family === 'IPv4' && !i.internal && !/^(172\.(1[7-9]|2\d|3[01])|10\.88)\./.test(i.address) && !tailscale.isTailscaleIp(i.address))
    .map((i) => i.address);
  res.json({
    image: docker.IMAGE,
    imagePresent: await docker.imagePresent(),
    envCatalog: ENV_CATALOG,
    worldPresets: WORLD_PRESETS,
    worldModifiers: WORLD_MODIFIERS,
    worldKeys: WORLD_KEYS,
    suggestedPort: await suggestPort(servers),
    hostIps: ips,
    hostname: os.hostname(),
    tailscale: await tailscale.info(),
  });
}));

app.get('/api/servers', wrap(async (req, res) => {
  const [servers, status] = await Promise.all([store.list(), docker.statusAll()]);
  const running = servers.filter((s) => status[s.id]?.state === 'running').map((s) => s.id);
  const st = req.query.stats ? await docker.stats(running).catch(() => ({})) : {};
  const seeds = await Promise.all(servers.map(seedOf));
  res.json(servers.map((s, i) => publicView(s, status[s.id], st, seeds[i])));
}));

app.get('/api/servers/:id', wrap(async (req, res) => {
  const s = await load(req.params.id);
  const status = await docker.statusAll();
  res.json(publicView(s, status[s.id], {}, await seedOf(s)));
}));

app.post('/api/servers', wrap(async (req, res) => {
  const servers = await store.list();
  const body = req.body || {};
  let id = slug(body.id || body.worldName || body.serverName || '');
  if (!store.ID_RE.test(id)) throw fail(400, 'Invalid id');
  for (let n = 2; servers.some((s) => s.id === id); n++) id = `${slug(body.worldName || 'world')}-${n}`;
  const server = {
    id,
    serverName: '',
    worldName: '',
    password: '',
    port: await suggestPort(servers),
    public: false,
    crossplay: false,
    modFramework: 'none',
    world: { preset: '', modifiers: {}, keys: [] },
    extraArgs: '',
    env: { TZ: Intl.DateTimeFormat().resolvedOptions().timeZone || 'Etc/UTC' },
    mods: {},
    createdAt: new Date().toISOString(),
  };
  applyFields(server, { serverName: '', ...body }, servers);
  await store.save(server);
  if (body.start) {
    runJob(id, 'creating', async () => {
      await ensureContainer(server, null);
      await docker.start(id);
    });
  }
  res.status(201).json(publicView(server, null));
}));

app.put('/api/servers/:id', wrap(async (req, res) => {
  const out = await withLock(req.params.id, async () => {
    const s = await load(req.params.id);
    const servers = await store.list();
    applyFields(s, req.body || {}, servers);
    await store.save(s);
    return s;
  });
  const status = await docker.statusAll();
  res.json(publicView(out, status[out.id]));
}));

// start | stop | restart | reload. Runs in the background; returns the job promise.
//  restart: re-creates the container only if settings changed, else docker restart
//  reload:  always re-creates it, re-applying settings and re-syncing mods, then starts
const ACTION_LABELS = { start: 'starting', stop: 'stopping', restart: 'restarting', reload: 'reloading' };
function serverAction(id, action) {
  return runJob(id, ACTION_LABELS[action], async () => {
    const fresh = await load(id);
    const st = (await docker.statusAll())[id];
    if (action === 'stop') {
      if (st?.state === 'running') await docker.stop(id);
      return;
    }
    const pending = !st || st.hash !== docker.runHash(fresh);
    if (pending || action === 'reload') {
      await ensureContainer(fresh, st, action === 'reload'); // stops + recreates
      await docker.start(id);
    } else if (action === 'restart' && st.state === 'running') {
      await docker.restart(id);
    } else {
      await docker.start(id);
    }
  });
}

app.post('/api/servers/:id/:action(start|stop|restart|reload)', wrap(async (req, res) => {
  const { id, action } = req.params;
  const s = await load(id);
  serverAction(id, action);
  res.status(202).json({ ok: true, id: s.id });
}));

app.delete('/api/servers/:id', wrap(async (req, res) => {
  const { id } = req.params;
  await load(id);
  if (jobs.has(id)) throw fail(409, 'Server is busy');
  runJob(id, 'deleting', async () => {
    const st = (await docker.statusAll())[id];
    if (st?.state === 'running') await docker.stop(id);
    await docker.removeContainer(id);
    if (req.query.purge === '1') {
      try {
        await store.remove(id);
      } catch (e) {
        if (e.code !== 'EACCES' && e.code !== 'EPERM') throw e;
        await docker.chownBack(store.serverDir(id));
        await store.remove(id);
      }
    }
  });
  res.status(202).json({ ok: true });
}));

app.get('/api/servers/:id/logs', wrap(async (req, res) => {
  await load(req.params.id);
  const tail = Math.min(Number(req.query.tail) || 400, 5000);
  res.type('text/plain').send(await docker.logs(req.params.id, tail));
}));

// --- worlds ---

async function listDir(dir) {
  let entries;
  try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return []; }
  const out = [];
  for (const e of entries) {
    const st = await fs.stat(path.join(dir, e.name)).catch(() => null);
    if (st) out.push({ name: e.name, dir: e.isDirectory(), size: st.size, modified: st.mtime });
  }
  return out.sort((a, b) => b.modified - a.modified);
}

app.get('/api/servers/:id/worlds', wrap(async (req, res) => {
  const s = await load(req.params.id);
  const cfg = store.configDir(s.id);
  res.json({
    worlds: await listDir(path.join(cfg, 'worlds_local')),
    backups: await listDir(path.join(cfg, 'backups')),
  });
}));

// Upload an existing world: a .zip (world folder or .db/.fwl files) or a single .db/.fwl file.
app.post('/api/servers/:id/worlds/upload', express.raw({ type: '*/*', limit: '2gb' }), wrap(async (req, res) => {
  const s = await load(req.params.id);
  const name = path.basename(String(req.query.filename || ''));
  const dir = path.join(store.configDir(s.id), 'worlds_local');
  await fs.mkdir(dir, { recursive: true });
  const written = [];
  if (/\.(db|fwl)(\.old)?$/i.test(name)) {
    await fs.writeFile(path.join(dir, name), req.body);
    written.push(name);
  } else if (/\.zip$/i.test(name)) {
    for (const e of new AdmZip(req.body).getEntries()) {
      if (e.isDirectory) continue;
      const dest = path.resolve(dir, e.entryName);
      if (!dest.startsWith(dir + path.sep)) throw fail(400, `Unsafe path ${e.entryName}`);
      await fs.mkdir(path.dirname(dest), { recursive: true });
      await fs.writeFile(dest, e.getData());
      written.push(e.entryName);
    }
  } else {
    throw fail(400, 'Upload a .zip, .db or .fwl file');
  }
  res.json({ written });
}));

// --- mods ---

app.get('/api/thunderstore/search', wrap(async (req, res) => {
  res.json(await mods.search(String(req.query.q || ''), Number(req.query.page) || 1));
}));

app.get('/api/servers/:id/mods', wrap(async (req, res) => {
  const s = await load(req.params.id);
  res.json({ framework: s.modFramework, mods: s.mods || {}, manualFiles: await mods.manualFiles(s) });
}));

app.get('/api/servers/:id/mods/updates', wrap(async (req, res) => {
  const s = await load(req.params.id);
  const names = Object.entries(s.mods || {}).filter(([, m]) => m.source === 'thunderstore').map(([n]) => n);
  res.json(await mods.latestVersions(names));
}));

app.post('/api/servers/:id/mods', wrap(async (req, res) => {
  const result = await withLock(req.params.id, async () => {
    const s = await load(req.params.id);
    const installed = await mods.install(s, String(req.body?.name || ''), req.body?.version);
    await store.save(s);
    return installed;
  });
  res.json({ installed: result, restartRequired: true });
}));

app.post('/api/servers/:id/mods/upload', express.raw({ type: '*/*', limit: '512mb' }), wrap(async (req, res) => {
  const result = await withLock(req.params.id, async () => {
    const s = await load(req.params.id);
    const out = await mods.upload(s, String(req.query.filename || ''), req.body);
    await store.save(s);
    return out;
  });
  res.json({ installed: result, restartRequired: true });
}));

app.delete('/api/servers/:id/mods/_manual/:file', wrap(async (req, res) => {
  await withLock(req.params.id, async () => {
    const s = await load(req.params.id);
    await mods.removeManualFile(s, req.params.file);
    await store.save(s);
  });
  res.json({ ok: true, restartRequired: true });
}));

app.delete('/api/servers/:id/mods/:name', wrap(async (req, res) => {
  const removed = await withLock(req.params.id, async () => {
    const s = await load(req.params.id);
    if (req.params.name === '_manual') {
      for (const f of await mods.manualFiles(s)) await mods.removeManualFile(s, f);
      await store.save(s);
      return ['_manual'];
    }
    const out = await mods.uninstall(s, req.params.name);
    await store.save(s);
    return out;
  });
  res.json({ removed, restartRequired: true });
}));

app.get('/api/servers/:id/configs', wrap(async (req, res) => {
  res.json(await mods.listConfigs(await load(req.params.id)));
}));

app.get('/api/servers/:id/configs/:name', wrap(async (req, res) => {
  res.type('text/plain').send(await mods.readConfig(await load(req.params.id), req.params.name));
}));

app.put('/api/servers/:id/configs/:name', express.text({ type: '*/*', limit: '4mb' }), wrap(async (req, res) => {
  const s = await load(req.params.id);
  await mods.writeConfig(s, req.params.name, String(req.body ?? ''));
  res.json({ ok: true, restartRequired: true });
}));

// --- API keys (logged-in only) ---
// --- mod packs (so players can match the server's mods) ----------------------
const PACK_FILES = { 'profile.r2z': 'buildProfile', 'mods.zip': 'buildZip' };
async function sendPack(res, s, file, configs) {
  const buf = await modpack[PACK_FILES[file]](s, { configs });
  const base = modpack.fileBase(s);
  res.attachment(file === 'mods.zip' ? `${base}-mods.zip` : `${base}.r2z`);
  res.type('application/zip').send(buf);
}

app.get('/api/servers/:id/modpack', wrap(async (req, res) => {
  const s = await load(req.params.id);
  res.json({ ...modpack.summary(s), share: s.share || null });
}));

app.get('/api/servers/:id/modpack/:file(profile.r2z|mods.zip)', wrap(async (req, res) => {
  await sendPack(res, await load(req.params.id), req.params.file, req.query.configs === '1');
}));

// body: { enabled, configs, regenerate }
app.put('/api/servers/:id/share', wrap(async (req, res) => {
  const share = await withLock(req.params.id, async () => {
    const s = await load(req.params.id);
    const b = req.body || {};
    if (b.enabled === false) delete s.share;
    else {
      s.share = {
        token: !s.share || b.regenerate ? modpack.newToken() : s.share.token,
        configs: b.configs !== undefined ? Boolean(b.configs) : Boolean(s.share?.configs),
        createdAt: !s.share || b.regenerate ? new Date().toISOString() : s.share.createdAt,
      };
    }
    await store.save(s);
    return s.share || null;
  });
  res.json({ share });
}));

app.get('/api/keys', wrap(async (req, res) => res.json(await apikeys.list())));
app.post('/api/keys', wrap(async (req, res) => res.status(201).json(await apikeys.create(req.body || {}))));
app.delete('/api/keys/:id', wrap(async (req, res) => { await apikeys.revoke(req.params.id); res.json({ ok: true }); }));

// --- hook URLs (secret key, no login) ---------------------------------------
// GET or POST /hook/<server>/<status|start|stop|shutdown|restart|reload>
// key via `Authorization: Bearer <key>`, `X-API-Key: <key>` or `?key=<key>`.
// `?wait=1` blocks until the action finishes (max 5 min) and reports the result.
const hookFailures = new Map(); // ip -> { count, resetAt }
app.all('/hook/:id/:action', express.json({ limit: '1kb' }), wrap(async (req, res) => {
  if (!['GET', 'POST'].includes(req.method)) throw fail(405, 'Use GET or POST');
  const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress).split(',')[0].trim();
  const f = hookFailures.get(ip);
  if (f && f.resetAt > Date.now() && f.count >= 20) throw fail(429, 'Too many bad keys — try again later');

  const action = req.params.action === 'shutdown' ? 'stop' : req.params.action;
  if (!apikeys.ACTIONS.includes(action)) throw fail(404, `Unknown action; use ${apikeys.ACTIONS.join(', ')} (or shutdown)`);
  const bearer = (req.headers.authorization || '').match(/^Bearer\s+(\S+)$/i)?.[1];
  const secret = bearer || req.headers['x-api-key'] || req.query.key || req.body?.key;
  const verdict = await apikeys.check(String(secret || ''), req.params.id, action);
  if (!verdict.ok) {
    if (verdict.status === 401) {
      const now = Date.now();
      if (!f || f.resetAt < now) hookFailures.set(ip, { count: 1, resetAt: now + 15 * 60_000 });
      else f.count++;
    }
    throw fail(verdict.status, verdict.error || 'Missing or invalid key');
  }

  const s = await load(req.params.id);
  const describe = async () => {
    const st = (await docker.statusAll())[s.id];
    return {
      server: s.id,
      name: s.serverName,
      world: s.worldName,
      port: s.port,
      state: st?.state || 'not created',
      busy: jobs.get(s.id)?.action || null,
      pendingChanges: st ? st.hash !== docker.runHash(await load(s.id)) : false,
      lastError: lastError.get(s.id)?.message || null,
      seed: (await seedOf(s))?.seedName || null,
    };
  };
  if (action === 'status') return res.json(await describe());

  const job = serverAction(s.id, action);
  if (req.query.wait === '1' || req.body?.wait) {
    const error = await Promise.race([job, new Promise((r) => setTimeout(() => r('timeout'), 300_000))]);
    if (error === 'timeout') return res.status(202).json({ ok: true, action, note: 'still running', ...(await describe()) });
    return res.status(error ? 500 : 200).json({ ok: !error, action, error, ...(await describe()) });
  }
  res.status(202).json({ ok: true, action, ...(await describe()) });
}));

// --- public share links (no login; the token is the secret) ------------------
async function findShared(token) {
  for (const s of await store.list()) if (s.share && modpack.tokenMatches(s.share.token, token)) return s;
  throw fail(404, 'This share link is invalid or was turned off');
}

app.get('/share/:token', wrap(async (req, res) => {
  let s;
  try { s = await findShared(req.params.token); } catch (e) { return res.status(404).type('html').send(sharePage(null)); }
  res.set('Referrer-Policy', 'no-referrer').type('html').send(sharePage(s, modpack.summary(s)));
}));

app.get('/share/:token/:file(profile.r2z|mods.zip)', wrap(async (req, res) => {
  const s = await findShared(req.params.token);
  await sendPack(res, s, req.params.file, Boolean(s.share.configs));
}));

app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

app.use((err, req, res, _next) => {
  const status = err.status || (err.code === 'ENOENT' ? 404 : err.code === 'EACCES' ? 403 : 500);
  if (status >= 500) console.error(err);
  res.status(status).json({ error: err.message });
});

app.listen(PORT, HOST, () => {
  console.log(`Valheim Manager on http://${HOST}:${PORT}  (data: ${store.DATA_DIR})`);
});
