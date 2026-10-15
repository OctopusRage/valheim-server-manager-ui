// Thunderstore search + per-server mod install/remove.
//
// The container syncs <modRoot>/plugins and <modRoot>/patchers into the server's
// BepInEx directory on start, and symlinks BepInEx/config to <modRoot>, so mod
// .cfg files live directly in <modRoot>. Each package goes into its own
// plugins/<Namespace-Name>/ folder so it can be removed cleanly.
import fs from 'node:fs/promises';
import path from 'node:path';
import AdmZip from 'adm-zip';
import { modRoot } from './store.js';

const TS = 'https://thunderstore.io';
// provided by the image itself (BEPINEX=true / VALHEIM_PLUS=true)
const BUILTIN = new Set(['denikson-BepInExPack_Valheim', 'Grantapher-ValheimPlus', 'valheimPlus-ValheimPlus']);
// not installable into a server: the loader itself and client-side mod managers
const HIDDEN = new Set([...BUILTIN, 'ebkr-r2modman', 'Kesomannen-GaleModManager']);
const PKG_RE = /^[A-Za-z0-9_]+-[A-Za-z0-9_]+$/;
const CFG_RE = /^[\w.\- ]+\.(cfg|ya?ml|json)$/;
const META_FILES = /^(manifest\.json|icon\.png|readme\.md|changelog\.md|license(\.\w+)?)$/i;

async function getJson(url) {
  const res = await fetch(url, { headers: { 'User-Agent': 'valheim-manager' } });
  if (!res.ok) throw httpError(res.status === 404 ? 404 : 502, `Thunderstore ${res.status} for ${url}`);
  return res.json();
}

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

export async function search(q, page = 1) {
  const params = new URLSearchParams({ q, page: String(page), ordering: 'most-downloaded', deprecated: 'False', nsfw: 'False' });
  const data = await getJson(`${TS}/api/cyberstorm/listing/valheim/?${params}`);
  return {
    count: data.count,
    hasMore: Boolean(data.next),
    results: data.results.filter((r) => !HIDDEN.has(`${r.namespace}-${r.name}`)).map((r) => ({
      fullName: `${r.namespace}-${r.name}`,
      namespace: r.namespace,
      name: r.name,
      description: r.description,
      icon: r.icon_url,
      downloads: r.download_count,
      updated: r.last_updated,
      categories: (r.categories || []).map((c) => c.name),
    })),
  };
}

async function resolve(fullName, version) {
  const [ns, name] = fullName.split('-');
  if (version) {
    const v = await getJson(`${TS}/api/experimental/package/${ns}/${name}/${encodeURIComponent(version)}/`);
    return v;
  }
  const p = await getJson(`${TS}/api/experimental/package/${ns}/${name}/`);
  return p.latest;
}

export async function latestVersions(fullNames) {
  const out = {};
  await Promise.all(fullNames.map(async (n) => {
    try { out[n] = (await resolve(n)).version_number; } catch { /* leave unknown */ }
  }));
  return out;
}

function ensureRoot(server) {
  const root = modRoot(server);
  if (!root) throw httpError(400, 'Pick a mod framework (BepInEx or ValheimPlus) for this server first');
  return root;
}

function inside(base, rel) {
  const dest = path.resolve(base, rel);
  if (dest !== base && !dest.startsWith(base + path.sep)) throw httpError(400, `Unsafe path in archive: ${rel}`);
  return dest;
}

// Map a Thunderstore archive entry onto <modRoot>; null = skip.
function mapEntry(root, pkg, rel) {
  let p = rel.replace(/\\/g, '/').replace(/^\/+/, '');
  p = p.replace(/^BepInEx\//i, '');
  const [head, ...rest] = p.split('/');
  const tail = rest.join('/');
  const h = head.toLowerCase();
  if (h === 'plugins') return { dest: inside(root, `plugins/${pkg}/${tail}`) };
  if (h === 'patchers') return { dest: inside(root, `patchers/${pkg}/${tail}`) };
  if (h === 'config') return { dest: inside(root, tail), keepExisting: true };
  if (h === 'core' || h === 'monomod') return null;
  if (!rest.length && META_FILES.test(head)) return null;
  return { dest: inside(root, `plugins/${pkg}/${p}`) };
}

async function extractPackage(root, pkg, buffer) {
  const zip = new AdmZip(buffer);
  await removeFiles(root, pkg);
  let files = 0;
  for (const e of zip.getEntries()) {
    if (e.isDirectory) continue;
    const m = mapEntry(root, pkg, e.entryName);
    if (!m) continue;
    if (m.keepExisting && await exists(m.dest)) continue;
    await fs.mkdir(path.dirname(m.dest), { recursive: true });
    await fs.writeFile(m.dest, e.getData());
    files++;
  }
  return files;
}

async function exists(p) {
  try { await fs.access(p); return true; } catch { return false; }
}

async function removeFiles(root, pkg) {
  await fs.rm(path.join(root, 'plugins', pkg), { recursive: true, force: true });
  await fs.rm(path.join(root, 'patchers', pkg), { recursive: true, force: true });
}

// Installs a package and (recursively) its dependencies. Mutates server.mods.
export async function install(server, fullName, version) {
  if (!PKG_RE.test(fullName)) throw httpError(400, 'Package must look like Namespace-Name');
  const root = ensureRoot(server);
  server.mods ||= {};
  const installed = [];
  const visit = async (name, ver, explicit) => {
    if (BUILTIN.has(name)) return;
    const already = server.mods[name];
    if (already && !explicit) return; // keep whatever dependency version is present
    const v = await resolve(name, ver);
    const res = await fetch(v.download_url, { headers: { 'User-Agent': 'valheim-manager' } });
    if (!res.ok) throw httpError(502, `Download of ${v.full_name} failed: ${res.status}`);
    await extractPackage(root, name, Buffer.from(await res.arrayBuffer()));
    const deps = v.dependencies.map((d) => d.split('-').slice(0, 2).join('-')).filter((d) => !BUILTIN.has(d));
    server.mods[name] = {
      version: v.version_number,
      explicit: explicit || Boolean(already?.explicit),
      deps,
      description: v.description,
      icon: v.icon,
      source: 'thunderstore',
    };
    installed.push(`${name} ${v.version_number}`);
    for (const d of deps) await visit(d, null, false);
  };
  await visit(fullName, version, true);
  return installed;
}

// Removes a mod plus dependencies nothing else needs. Mutates server.mods.
export async function uninstall(server, name) {
  const root = ensureRoot(server);
  if (!server.mods?.[name]) throw httpError(404, `${name} is not installed`);
  const dependents = Object.entries(server.mods).filter(([, m]) => m.deps?.includes(name)).map(([n]) => n);
  if (dependents.length) throw httpError(409, `${name} is required by ${dependents.join(', ')} — remove those first`);
  const removed = [];
  const drop = async (n) => {
    const mod = server.mods[n];
    if (!mod) return;
    delete server.mods[n];
    await removeFiles(root, n);
    removed.push(n);
    for (const d of mod.deps || []) {
      const dep = server.mods[d];
      const stillNeeded = Object.values(server.mods).some((m) => m.deps?.includes(d));
      if (dep && !dep.explicit && !stillNeeded) await drop(d);
    }
  };
  await drop(name);
  return removed;
}

// Manual upload: a .dll goes to plugins/_manual/, a .zip is treated as a package.
export async function upload(server, filename, buffer) {
  const root = ensureRoot(server);
  const base = path.basename(filename);
  if (/\.dll$/i.test(base)) {
    const dest = inside(root, `plugins/_manual/${base}`);
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.writeFile(dest, buffer);
    server.mods ||= {};
    server.mods._manual = { version: '-', explicit: true, deps: [], description: 'Manually uploaded DLLs', source: 'manual' };
    return [`_manual/${base}`];
  }
  if (/\.zip$/i.test(base)) {
    let name = base.replace(/\.zip$/i, '').replace(/[^A-Za-z0-9_-]/g, '_');
    let version = '-';
    let description = 'Uploaded archive';
    const manifest = new AdmZip(buffer).getEntry('manifest.json');
    if (manifest) {
      try {
        const m = JSON.parse(manifest.getData().toString('utf8').replace(/^﻿/, ''));
        if (m.name) name = m.author ? `${m.author}-${m.name}` : m.name;
        version = m.version_number || version;
        description = m.description || description;
      } catch { /* fall back to file name */ }
    }
    name = name.replace(/[^A-Za-z0-9_-]/g, '_');
    await extractPackage(root, name, buffer);
    server.mods ||= {};
    server.mods[name] = { version, explicit: true, deps: [], description, source: 'upload' };
    return [name];
  }
  throw httpError(400, 'Upload a .dll or a .zip');
}

export async function manualFiles(server) {
  const root = modRoot(server);
  if (!root) return [];
  try { return await fs.readdir(path.join(root, 'plugins', '_manual')); } catch { return []; }
}

export async function removeManualFile(server, file) {
  const root = ensureRoot(server);
  await fs.rm(inside(path.join(root, 'plugins', '_manual'), path.basename(file)), { force: true });
  if (!(await manualFiles(server)).length) delete server.mods?._manual;
}

export async function listConfigs(server) {
  const root = modRoot(server);
  if (!root) return [];
  let names;
  try { names = await fs.readdir(root); } catch { return []; }
  const out = [];
  for (const n of names.filter((f) => CFG_RE.test(f)).sort()) {
    const st = await fs.stat(path.join(root, n));
    out.push({ name: n, size: st.size, modified: st.mtime });
  }
  return out;
}

function cfgPath(server, name) {
  const root = ensureRoot(server);
  if (!CFG_RE.test(name)) throw httpError(400, 'Invalid config file name');
  return inside(root, name);
}

export const readConfig = (server, name) => fs.readFile(cfgPath(server, name), 'utf8');

export async function writeConfig(server, name, text) {
  const p = cfgPath(server, name);
  if (await exists(p)) await fs.copyFile(p, p + '.bak');
  await fs.writeFile(p, text);
}
