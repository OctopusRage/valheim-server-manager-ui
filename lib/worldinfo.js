// Read a world's seed from its metadata file in config/worlds_local:
//   older Valheim:  <world>.fwl
//   newer Valheim:  <world>/_main.<n>.fwl2   (highest <n> is the latest save)
// Both are a ZPackage: int32 byte count, then int32 version, string name,
// string seedName, int32 seed, int64 uid, int32 worldGenVersion, …
// Strings are .NET BinaryWriter strings (7-bit encoded length + UTF-8).
import fs from 'node:fs/promises';
import path from 'node:path';

async function metaFile(worldsDir, world) {
  const dir = path.join(worldsDir, world);
  try {
    const saves = (await fs.readdir(dir))
      .map((f) => f.match(/^_main\.(\d+)\.fwl2$/))
      .filter(Boolean)
      .sort((a, b) => Number(b[1]) - Number(a[1]));
    if (saves.length) return path.join(dir, saves[0][0]);
  } catch { /* no folder: try the old single-file layout */ }
  const old = path.join(worldsDir, `${world}.fwl`);
  try { await fs.access(old); return old; } catch { return null; }
}

function reader(buf) {
  let o = 0;
  const need = (n) => { if (o + n > buf.length) throw new Error('truncated'); };
  return {
    i32() { need(4); const v = buf.readInt32LE(o); o += 4; return v; },
    str() {
      let len = 0;
      for (let shift = 0; ; shift += 7) {
        need(1);
        const b = buf[o++];
        len |= (b & 0x7f) << shift;
        if (!(b & 0x80)) break;
        if (shift > 28) throw new Error('bad string length');
      }
      need(len);
      const s = buf.toString('utf8', o, o + len);
      o += len;
      return s;
    },
  };
}

const cache = new Map(); // file -> { mtimeMs, info }

// -> { seedName, seed, name, version, file } or null when the world doesn't exist yet
export async function worldInfo(worldsDir, world) {
  if (!world) return null;
  const file = await metaFile(worldsDir, world);
  if (!file) return null;
  const st = await fs.stat(file);
  const hit = cache.get(file);
  if (hit && hit.mtimeMs === st.mtimeMs) return hit.info && { ...hit.info, generated: await hasTerrain(file) };
  let info = null;
  try {
    const r = reader(await fs.readFile(file));
    r.i32(); // package length
    const version = r.i32();
    const name = r.str();
    const seedName = r.str();
    const seed = r.i32();
    info = { seedName, seed, name, version, file: path.relative(worldsDir, file) };
  } catch { /* unreadable / unknown format */ }
  cache.set(file, { mtimeMs: st.mtimeMs, info });
  return info && { ...info, generated: await hasTerrain(file) };
}

// The world's data (.db2 / .db) exists, i.e. it has been generated and saved.
async function hasTerrain(file) {
  const db = file.endsWith('.fwl2') ? file.replace(/\.fwl2$/, '.db2') : file.replace(/\.fwl$/, '.db');
  try { await fs.access(db); return true; } catch { return false; }
}

// --- pre-seeding a new world --------------------------------------------------

// Valheim's string.GetStableHashCode(): how a seed name becomes the numeric seed.
export function seedHash(str) {
  let a = 5381;
  let b = 5381;
  for (let i = 0; i < str.length && str.charCodeAt(i) !== 0; i += 2) {
    a = (Math.imul(a, 33) ^ str.charCodeAt(i)) | 0;
    if (i === str.length - 1 || str.charCodeAt(i + 1) === 0) break;
    b = (Math.imul(b, 33) ^ str.charCodeAt(i + 1)) | 0;
  }
  return (a + Math.imul(b, 1566083941)) | 0;
}

// Same characters the in-game seed box accepts, max 10.
export const SEED_RE = /^[A-Za-z0-9]{1,10}$/;

function str7(s) {
  const bytes = Buffer.from(s, 'utf8');
  const len = [];
  let n = bytes.length;
  do { len.push((n & 0x7f) | (n > 0x7f ? 0x80 : 0)); n >>>= 7; } while (n);
  return Buffer.concat([Buffer.from(len), bytes]);
}

const WORLD_VERSION = 42; // what the current dedicated server writes

// Writes the metadata of a not-yet-generated world (no .db), like the server
// does when it creates one, so the first start generates from this seed.
// No _main.0.ok: the server deletes a .ok save that has no .db2 as an orphan.
export async function writeSeededWorld(worldsDir, world, seedName) {
  if (!SEED_RE.test(seedName)) throw Object.assign(new Error('Seed must be 1–10 letters or digits'), { status: 400 });
  const existing = await metaFile(worldsDir, world);
  if (existing && await hasTerrain(existing)) throw Object.assign(new Error(`World "${world}" already exists — its seed can't be changed`), { status: 409 });
  if (existing) await fs.rm(existing); // pre-seeded but never generated: replace it
  const i32 = (v) => { const b = Buffer.alloc(4); b.writeInt32LE(v); return b; };
  const uid = Buffer.alloc(8);
  uid.writeBigInt64LE(BigInt.asIntN(64, BigInt(Math.floor(Math.random() * 2 ** 53))));
  const body = Buffer.concat([
    i32(WORLD_VERSION),
    str7(world),
    str7(seedName),
    i32(seedHash(seedName)),
    uid,
    i32(2), // worldGenVersion
    Buffer.from([0]), // needsDB: false -> generate on first start
    i32(0), // starting global keys: none (preset/modifiers come from server args)
    i32(0),
  ]);
  const dir = path.join(worldsDir, world);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, '_main.0.fwl2'), Buffer.concat([i32(body.length), body]));
}
