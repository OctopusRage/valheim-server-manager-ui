// Single admin password + cookie sessions.
//
// The password is stored scrypt-hashed in DATA_DIR/auth.json. It is set either
// through the first-run setup screen (only accepted from a loopback address, so a
// manager exposed on the LAN can't be claimed by someone else) or with
// `npm run set-password`. VHM_PASSWORD in the environment overrides the file.
import { randomBytes, scrypt as scryptCb, timingSafeEqual, createHash } from 'node:crypto';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import path from 'node:path';
import { DATA_DIR } from './store.js';

const scrypt = promisify(scryptCb);
const AUTH_FILE = path.join(DATA_DIR, 'auth.json');
const COOKIE = 'vhm_session';
const SESSION_TTL = 30 * 24 * 3600 * 1000;
const MAX_ATTEMPTS = 10;
const ATTEMPT_WINDOW = 15 * 60 * 1000;

const sessions = new Map(); // sha256(token) -> expiresAt
const attempts = new Map(); // ip -> { count, resetAt }

export const MIN_PASSWORD = 8;

async function readStored() {
  try {
    return JSON.parse(await fs.readFile(AUTH_FILE, 'utf8'));
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
}

export async function isConfigured() {
  return Boolean(process.env.VHM_PASSWORD) || Boolean(await readStored());
}

export async function setPassword(password) {
  if (typeof password !== 'string' || password.length < MIN_PASSWORD) {
    throw Object.assign(new Error(`Password must be at least ${MIN_PASSWORD} characters`), { status: 400 });
  }
  const salt = randomBytes(16);
  const hash = await scrypt(password, salt, 64);
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(AUTH_FILE, JSON.stringify({ salt: salt.toString('hex'), hash: hash.toString('hex') }), { mode: 0o600 });
  sessions.clear(); // a password change logs everyone out
}

async function verify(password) {
  if (typeof password !== 'string') return false;
  if (process.env.VHM_PASSWORD) {
    const a = createHash('sha256').update(password).digest();
    const b = createHash('sha256').update(process.env.VHM_PASSWORD).digest();
    return timingSafeEqual(a, b);
  }
  const stored = await readStored();
  if (!stored) return false;
  const hash = await scrypt(password, Buffer.from(stored.salt, 'hex'), 64);
  return timingSafeEqual(hash, Buffer.from(stored.hash, 'hex'));
}

const tokenKey = (t) => createHash('sha256').update(t).digest('hex');

function readCookie(req) {
  const m = (req.headers.cookie || '').match(new RegExp(`(?:^|;\\s*)${COOKIE}=([A-Za-z0-9_-]+)`));
  return m ? m[1] : null;
}

function setCookie(req, res, value, maxAgeMs) {
  const secure = req.secure || req.headers['x-forwarded-proto'] === 'https';
  res.setHeader('Set-Cookie', [
    `${COOKIE}=${value}`, 'Path=/', 'HttpOnly', 'SameSite=Strict',
    `Max-Age=${Math.floor(maxAgeMs / 1000)}`, secure ? 'Secure' : '',
  ].filter(Boolean).join('; '));
}

// A proxy on the same host (tailscale serve, caddy, nginx) also connects from
// 127.0.0.1, so a forwarded request is never treated as local.
export function isLoopback(req) {
  if (req.headers['x-forwarded-for'] || req.headers['tailscale-user-login'] || req.headers.forwarded) return false;
  const ip = req.socket.remoteAddress || '';
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
}

export function hasSession(req) {
  const token = readCookie(req);
  if (!token) return false;
  const key = tokenKey(token);
  const exp = sessions.get(key);
  if (!exp) return false;
  if (exp < Date.now()) { sessions.delete(key); return false; }
  return true;
}

function startSession(req, res) {
  const token = randomBytes(32).toString('base64url');
  sessions.set(tokenKey(token), Date.now() + SESSION_TTL);
  setCookie(req, res, token, SESSION_TTL);
}

function tooMany(ip) {
  const a = attempts.get(ip);
  return a && a.resetAt > Date.now() && a.count >= MAX_ATTEMPTS;
}

function recordFailure(ip) {
  const now = Date.now();
  const a = attempts.get(ip);
  if (!a || a.resetAt < now) attempts.set(ip, { count: 1, resetAt: now + ATTEMPT_WINDOW });
  else a.count++;
}

// Express handlers -----------------------------------------------------------

export async function status(req, res) {
  res.json({ configured: await isConfigured(), authenticated: hasSession(req), canSetup: isLoopback(req), minLength: MIN_PASSWORD });
}

export async function setup(req, res) {
  if (await isConfigured()) return res.status(409).json({ error: 'A password is already set' });
  if (!isLoopback(req)) return res.status(403).json({ error: 'First-time setup must be done on the host itself (http://127.0.0.1)' });
  await setPassword(req.body?.password);
  startSession(req, res);
  res.json({ ok: true });
}

const clientIp = (req) => String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '?').split(',')[0].trim();

export async function login(req, res) {
  const ip = clientIp(req);
  if (tooMany(ip)) return res.status(429).json({ error: 'Too many attempts — try again in 15 minutes' });
  if (!(await verify(req.body?.password))) {
    recordFailure(ip);
    return res.status(401).json({ error: 'Wrong password' });
  }
  attempts.delete(ip);
  startSession(req, res);
  res.json({ ok: true });
}

export function logout(req, res) {
  const token = readCookie(req);
  if (token) sessions.delete(tokenKey(token));
  setCookie(req, res, '', 0);
  res.json({ ok: true });
}

export async function changePassword(req, res) {
  if (process.env.VHM_PASSWORD) return res.status(400).json({ error: 'Password comes from VHM_PASSWORD; change it there' });
  if (!(await verify(req.body?.current))) return res.status(401).json({ error: 'Current password is wrong' });
  await setPassword(req.body?.password);
  startSession(req, res);
  res.json({ ok: true });
}

// Guards every /api route except /api/auth/*.
export function requireAuth(req, res, next) {
  if (hasSession(req)) return next();
  res.status(401).json({ error: 'Login required', auth: true });
}

// Reject cross-site state-changing requests (defence on top of SameSite=Strict).
export function sameOrigin(req, res, next) {
  if (req.method === 'GET' || req.method === 'HEAD') return next();
  const origin = req.headers.origin;
  if (origin) {
    let host;
    try { host = new URL(origin).host; } catch { host = null; }
    if (host !== req.headers.host) return res.status(403).json({ error: 'Cross-origin request blocked' });
  }
  next();
}
