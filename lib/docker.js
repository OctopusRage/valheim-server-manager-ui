// Thin wrapper around the docker CLI (execFile, never a shell).
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { configDir, installDir, serverDir, containerEnv } from './store.js';

export const IMAGE = process.env.VALHEIM_IMAGE || 'ghcr.io/community-valheim-tools/valheim-server';
const PREFIX = 'vhm-';

export const containerName = (id) => PREFIX + id;

function docker(args, { timeout = 60_000 } = {}) {
  return new Promise((resolve, reject) => {
    execFile('docker', args, { timeout, maxBuffer: 32 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        err.message = (stderr || err.message).trim();
        return reject(err);
      }
      resolve(stdout);
    });
  });
}

// Hash of everything that requires a container re-create when it changes.
export function runHash(server) {
  return createHash('sha256')
    .update(JSON.stringify([IMAGE, server.port, containerEnv(server)]))
    .digest('hex').slice(0, 16);
}

// state for every managed container, keyed by server id
export async function statusAll() {
  const out = await docker(['ps', '-a', '--filter', 'label=vhm.managed=1', '--format', '{{json .}}']);
  const result = {};
  for (const line of out.split('\n').filter(Boolean)) {
    const c = JSON.parse(line);
    const labels = Object.fromEntries(c.Labels.split(',').map((l) => l.split('=')));
    if (!labels['vhm.id']) continue;
    result[labels['vhm.id']] = { state: c.State, status: c.Status, hash: labels['vhm.hash'] };
  }
  return result;
}

export async function stats(ids) {
  if (!ids.length) return {};
  const out = await docker(['stats', '--no-stream', '--format', '{{json .}}', ...ids.map(containerName)]);
  const result = {};
  for (const line of out.split('\n').filter(Boolean)) {
    const s = JSON.parse(line);
    result[s.Name.slice(PREFIX.length)] = { cpu: s.CPUPerc, mem: s.MemUsage };
  }
  return result;
}

export async function create(server) {
  // docker create pulls the image on first use (~1 GB), hence the long timeout
  const p = server.port;
  await docker([
    'create',
    '--name', containerName(server.id),
    '--label', 'vhm.managed=1',
    '--label', `vhm.id=${server.id}`,
    '--label', `vhm.hash=${runHash(server)}`,
    '--cap-add', 'sys_nice',
    '--stop-timeout', '120',
    '--restart', 'unless-stopped',
    // game port, query port, and +2 for crossplay / RPC-using mods
    '-p', `${p}-${p + 2}:${p}-${p + 2}/udp`,
    '-v', `${configDir(server.id)}:/config`,
    '-v', `${installDir(server.id)}:/opt/valheim`,
    '--env-file', path.join(serverDir(server.id), 'server.env'),
    IMAGE,
  ], { timeout: 900_000 });
}

export const start = (id) => docker(['start', containerName(id)]);
export const stop = (id) => docker(['stop', '-t', '120', containerName(id)], { timeout: 180_000 });
export const restart = (id) => docker(['restart', '-t', '120', containerName(id)], { timeout: 180_000 });

export async function removeContainer(id) {
  try {
    await docker(['rm', '-f', containerName(id)]);
  } catch (e) {
    if (!/No such container/i.test(e.message)) throw e;
  }
}

export const logs = (id, tail = 400) =>
  docker(['logs', '--timestamps', '--tail', String(tail), containerName(id)])
    .catch((e) => (/No such container/i.test(e.message) ? '' : Promise.reject(e)));

// Files the container wrote as root (e.g. the steam install) can't be removed or
// edited by us; hand them back to our uid using the image itself.
export async function chownBack(dir) {
  await docker([
    'run', '--rm', '--entrypoint', 'chown', '-v', `${dir}:/fix`, IMAGE,
    '-R', `${process.getuid()}:${process.getgid()}`, '/fix',
  ], { timeout: 300_000 });
}

export async function pullImage() {
  return docker(['pull', IMAGE], { timeout: 600_000 });
}

export async function imagePresent() {
  try {
    await docker(['image', 'inspect', IMAGE]);
    return true;
  } catch {
    return false;
  }
}
