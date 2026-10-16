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
  if (hit && hit.mtimeMs === st.mtimeMs) return hit.info;
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
  return info;
}
