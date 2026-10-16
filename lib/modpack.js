// Client mod packs, so players can match a server's mods.
//
// - profile.r2z: an r2modman / Thunderstore Mod Manager / Gale profile export.
//   It lists every Thunderstore mod at the server's exact version; the mod
//   manager downloads them. Optionally carries the mod config files.
// - mods.zip: everything in one archive to extract into the Valheim folder:
//   BepInExPack (the loader) + the server's plugins/patchers, including mods
//   uploaded by hand that aren't on Thunderstore.
//
// Shared publicly through /share/<token>; the token lives in server.share.
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import AdmZip from 'adm-zip';
import { DATA_DIR, modRoot } from './store.js';

const TS = 'https://thunderstore.io';
const LOADER = 'denikson-BepInExPack_Valheim';
const CACHE = path.join(DATA_DIR, 'cache');
// server-side files that make no sense (or could leak settings) on a client
const SKIP_CONFIG = /^(BepInEx\.cfg(\.default)?|.*\.bak)$/i;

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

export function newToken() {
  return randomBytes(24).toString('base64url');
}

export function tokenMatches(a, b) {
  if (!a || !b) return false;
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
}

function root(server) {
  const r = modRoot(server);
  if (!r) throw httpError(400, 'This server is vanilla — there are no mods to share');
  return r;
}

// The mod list players need, in install order (loader first).
export function summary(server) {
  const list = Object.entries(server.mods || {}).map(([name, m]) => ({
    name,
    version: m.version,
    description: m.description || '',
    icon: m.icon || null,
    source: m.source,
    explicit: Boolean(m.explicit),
    url: m.source === 'thunderstore' ? `${TS}/c/valheim/p/${name.replace('-', '/')}/` : null,
  })).sort((a, b) => (b.explicit - a.explicit) || a.name.localeCompare(b.name));
  return {
    framework: server.modFramework,
    mods: list,
    thunderstore: list.filter((m) => m.source === 'thunderstore').length,
    manual: list.filter((m) => m.source !== 'thunderstore').map((m) => m.name),
  };
}

async function loaderPackage() {
  const res = await fetch(`${TS}/api/experimental/package/denikson/BepInExPack_Valheim/`, { headers: { 'User-Agent': 'valheim-manager' } });
  if (!res.ok) throw httpError(502, `Thunderstore ${res.status} looking up BepInExPack`);
  return (await res.json()).latest;
}

// BepInExPack archive, cached per version under DATA_DIR/cache.
async function loaderZip() {
  const v = await loaderPackage();
  const file = path.join(CACHE, `${v.full_name}.zip`);
  try { return await fs.readFile(file); } catch { /* download below */ }
  const res = await fetch(v.download_url, { headers: { 'User-Agent': 'valheim-manager' } });
  if (!res.ok) throw httpError(502, `Download of ${v.full_name} failed: ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  await fs.mkdir(CACHE, { recursive: true });
  await fs.writeFile(file, buf);
  return buf;
}

async function walk(dir, rel = '') {
  let entries;
  try { entries = await fs.readdir(path.join(dir, rel), { withFileTypes: true }); } catch { return []; }
  const out = [];
  for (const e of entries) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...await walk(dir, r));
    else if (e.isFile()) out.push(r);
  }
  return out;
}

// Mod config files: everything in <modRoot> except the plugin folders and server-only files.
async function configFiles(server) {
  const r = root(server);
  return (await walk(r)).filter((f) => {
    const top = f.split('/')[0];
    return top !== 'plugins' && top !== 'patchers' && !SKIP_CONFIG.test(path.basename(f));
  });
}

const semver = (v) => {
  const [major = 0, minor = 0, patch = 0] = String(v).split('.').map((n) => Number.parseInt(n, 10) || 0);
  return { major, minor, patch };
};

// r2modman's export.r2x is YAML; this is the tiny subset it uses.
function r2x(name, mods) {
  const q = (s) => JSON.stringify(String(s));
  return [
    `profileName: ${q(name)}`,
    'mods:',
    ...mods.flatMap((m) => {
      const v = semver(m.version);
      return [
        `  - name: ${q(m.name)}`,
        '    version:',
        `      major: ${v.major}`,
        `      minor: ${v.minor}`,
        `      patch: ${v.patch}`,
        '    enabled: true',
      ];
    }),
    '',
  ].join('\n');
}

export async function buildProfile(server, { configs = false } = {}) {
  const r = root(server);
  if (server.modFramework !== 'bepinex') throw httpError(400, 'Mod manager profiles are only for BepInEx servers — use the zip');
  const loader = await loaderPackage();
  const mods = [
    { name: LOADER, version: loader.version_number },
    ...summary(server).mods.filter((m) => m.source === 'thunderstore'),
  ];
  const zip = new AdmZip();
  zip.addFile('export.r2x', Buffer.from(r2x(server.serverName || server.id, mods)));
  if (configs) {
    for (const f of await configFiles(server)) zip.addFile(`BepInEx/config/${f}`, await fs.readFile(path.join(r, f)));
  }
  return zip.toBuffer();
}

export async function buildZip(server, { configs = false } = {}) {
  const r = root(server);
  const zip = new AdmZip();
  const s = summary(server);

  if (server.modFramework === 'bepinex') {
    // BepInExPack_Valheim/<files> -> <Valheim folder>/<files>
    for (const e of new AdmZip(await loaderZip()).getEntries()) {
      const m = e.entryName.replace(/\\/g, '/').match(/^BepInExPack_Valheim\/(.+)$/);
      if (!m || e.isDirectory || /^start_server/i.test(m[1])) continue;
      zip.addFile(m[1], e.getData());
    }
  }
  for (const dir of ['plugins', 'patchers']) {
    for (const f of await walk(path.join(r, dir))) zip.addFile(`BepInEx/${dir}/${f}`, await fs.readFile(path.join(r, dir, f)));
  }
  if (configs) {
    for (const f of await configFiles(server)) zip.addFile(`BepInEx/config/${f}`, await fs.readFile(path.join(r, f)));
  }

  const lines = [
    `Mods for "${server.serverName}" (world ${server.worldName})`,
    '',
    'Install:',
    '  1. In Steam: right-click Valheim > Manage > Browse local files.',
    '  2. Extract this zip into that folder (it holds valheim.exe). Allow overwriting.',
    '  3. Start Valheim normally.',
    ...(server.modFramework === 'valheimplus'
      ? ['', 'This server runs ValheimPlus. Install the ValheimPlus client first:', '  https://github.com/Grantapher/ValheimPlus/releases', 'then extract this zip over it.']
      : ['', 'Linux / Steam Deck: set Valheim launch options to', '  ./start_game_bepinex.sh %command%']),
    '',
    'Mods:',
    ...s.mods.map((m) => `  ${m.name} ${m.version}${m.source === 'thunderstore' ? '' : '  (uploaded by hand)'}`),
    '',
    configs ? 'Mod config files are included in BepInEx/config.' : 'Mod config files are not included.',
    '',
  ];
  zip.addFile('MODS-README.txt', Buffer.from(lines.join('\r\n')));
  return zip.toBuffer();
}

export function fileBase(server) {
  return (server.id || 'server').replace(/[^a-z0-9-]/gi, '_');
}
