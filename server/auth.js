import crypto from 'node:crypto';
import { HttpError } from './errors.js';

export const SESSION_COOKIE = 'nexadesk_session';
export const SESSION_MAX_AGE = 7 * 24 * 60 * 60 * 1000;
export const ROLES = ['admin', 'agent'];
const USERNAME_PATTERN = /^[a-z0-9._-]{3,32}$/;

export function normalizeUsername(value) {
  return String(value || '').trim().toLowerCase();
}

export function validateUsername(value) {
  const username = normalizeUsername(value);
  if (!USERNAME_PATTERN.test(username)) {
    throw new HttpError(
      400,
      'Username 3–32 karakter, hanya huruf kecil, angka, titik, garis bawah, atau tanda hubung.',
    );
  }
  return username;
}

export function validatePassword(value) {
  const password = String(value || '');
  if (password.length < 8) throw new HttpError(400, 'Password minimal 8 karakter.');
  if (password.length > 128) throw new HttpError(400, 'Password maksimal 128 karakter.');
  return password;
}

export function validateName(value) {
  const name = String(value || '').trim().slice(0, 60);
  if (!name) throw new HttpError(400, 'Nama pengguna wajib diisi.');
  return name;
}

export function validateAccountIds(value, knownIds) {
  if (value === undefined) return [...knownIds];
  if (!Array.isArray(value)) throw new HttpError(400, 'Daftar akun harus berupa pilihan.');
  const clean = [...new Set(value.map((id) => String(id)))].filter((id) => knownIds.includes(id));
  return knownIds.filter((id) => clean.includes(id));
}

export function validateRole(value) {
  const role = String(value || 'agent');
  if (!ROLES.includes(role)) throw new HttpError(400, 'Peran tidak valid.');
  return role;
}

export function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return { salt, hash };
}

export function verifyPassword(user, password) {
  if (!user?.salt || !user?.passwordHash) return false;
  try {
    const candidate = crypto.scryptSync(String(password), user.salt, 64);
    const expected = Buffer.from(user.passwordHash, 'hex');
    return candidate.length === expected.length && crypto.timingSafeEqual(candidate, expected);
  } catch {
    return false;
  }
}

export function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const index = part.indexOf('=');
    if (index === -1) continue;
    const key = part.slice(0, index).trim();
    if (!key) continue;
    try {
      out[key] = decodeURIComponent(part.slice(index + 1).trim());
    } catch {
      out[key] = part.slice(index + 1).trim();
    }
  }
  return out;
}

export function publicUser(user) {
  if (!user) return null;
  return {
    id: user.id,
    username: user.username,
    name: user.name,
    role: user.role,
    accounts: Array.isArray(user.accounts) ? [...user.accounts] : [],
    active: user.active !== false,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
    lastLoginAt: user.lastLoginAt || null,
    lastSeenAt: user.lastSeenAt || null,
  };
}

export class Auth {
  constructor(store) {
    this.store = store;
    this.failures = new Map();
    if (!Array.isArray(this.store.data.users)) this.store.data.users = [];
    if (!this.store.data.meta.authSecret) {
      this.store.data.meta.authSecret = crypto.randomBytes(32).toString('hex');
      this.store.save();
    }
  }

  get users() {
    return this.store.data.users;
  }

  needsSetup() {
    return this.users.length === 0;
  }

  findById(id) {
    return this.users.find((user) => user.id === id) || null;
  }

  findByUsername(username) {
    const target = normalizeUsername(username);
    return this.users.find((user) => user.username === target) || null;
  }

  activeAdminCount(excludeId = null) {
    return this.users.filter(
      (user) => user.role === 'admin' && user.active !== false && user.id !== excludeId,
    ).length;
  }

  createUser({ name, username, password, role, active = true, accounts }) {
    const cleanName = validateName(name);
    const cleanUsername = validateUsername(username);
    const cleanPassword = validatePassword(password);
    const cleanRole = validateRole(role);
    const cleanAccounts = validateAccountIds(accounts, this.store.data.accounts.map((a) => a.id));
    if (this.findByUsername(cleanUsername)) {
      throw new HttpError(409, 'Username sudah digunakan.');
    }
    const { salt, hash } = hashPassword(cleanPassword);
    const now = Date.now();
    const user = {
      id: `u_${now}_${crypto.randomBytes(4).toString('hex')}`,
      name: cleanName,
      username: cleanUsername,
      role: cleanRole,
      accounts: cleanAccounts,
      active: active !== false,
      salt,
      passwordHash: hash,
      sessionVersion: 1,
      createdAt: now,
      updatedAt: now,
      lastLoginAt: null,
      lastSeenAt: null,
    };
    this.users.push(user);
    this.store.save();
    return user;
  }

  setPassword(user, password) {
    const cleanPassword = validatePassword(password);
    const { salt, hash } = hashPassword(cleanPassword);
    user.salt = salt;
    user.passwordHash = hash;
    user.sessionVersion = (user.sessionVersion || 1) + 1;
    user.updatedAt = Date.now();
    this.store.save();
  }

  checkRateLimit(ip, username) {
    const key = `${ip || 'unknown'}|${normalizeUsername(username)}`;
    const record = this.failures.get(key);
    if (!record) return;
    const now = Date.now();
    if (record.blockedUntil && record.blockedUntil > now) {
      const seconds = Math.ceil((record.blockedUntil - now) / 1000);
      throw new HttpError(429, `Terlalu banyak percobaan. Coba lagi dalam ${seconds} detik.`);
    }
    if (record.blockedUntil && record.blockedUntil <= now) {
      this.failures.delete(key);
    }
  }

  noteFailure(ip, username) {
    const key = `${ip || 'unknown'}|${normalizeUsername(username)}`;
    const now = Date.now();
    const record = this.failures.get(key) || { count: 0, firstAt: now, blockedUntil: 0 };
    if (now - record.firstAt > 10 * 60 * 1000) {
      record.count = 0;
      record.firstAt = now;
    }
    record.count += 1;
    if (record.count >= 5) {
      record.blockedUntil = now + 60 * 1000;
      record.count = 0;
    }
    this.failures.set(key, record);
  }

  clearFailures(ip, username) {
    this.failures.delete(`${ip || 'unknown'}|${normalizeUsername(username)}`);
  }

  login(username, password, ip) {
    this.checkRateLimit(ip, username);
    const user = this.findByUsername(username);
    if (!user || !verifyPassword(user, password)) {
      this.noteFailure(ip, username);
      throw new HttpError(401, 'Username atau password salah.');
    }
    if (user.active === false) {
      throw new HttpError(403, 'Akun ini dinonaktifkan. Hubungi admin.');
    }
    this.clearFailures(ip, username);
    user.lastLoginAt = Date.now();
    user.updatedAt = Date.now();
    this.store.save();
    return user;
  }

  signToken(user) {
    const payload = Buffer.from(
      JSON.stringify({
        uid: user.id,
        sv: user.sessionVersion || 1,
        exp: Date.now() + SESSION_MAX_AGE,
      }),
    ).toString('base64url');
    const signature = crypto
      .createHmac('sha256', this.store.data.meta.authSecret)
      .update(payload)
      .digest('base64url');
    return `${payload}.${signature}`;
  }

  verifyToken(token) {
    if (!token || typeof token !== 'string') return null;
    const [payload, signature] = token.split('.');
    if (!payload || !signature) return null;
    const expected = crypto
      .createHmac('sha256', this.store.data.meta.authSecret)
      .update(payload)
      .digest();
    let provided;
    try {
      provided = Buffer.from(signature, 'base64url');
    } catch {
      return null;
    }
    if (provided.length !== expected.length || !crypto.timingSafeEqual(provided, expected)) {
      return null;
    }
    let data;
    try {
      data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    } catch {
      return null;
    }
    if (!data?.uid || !data?.exp || data.exp < Date.now()) return null;
    const user = this.findById(data.uid);
    if (!user || user.active === false) return null;
    if ((user.sessionVersion || 1) !== data.sv) return null;
    return user;
  }

  userFromCookieHeader(header) {
    const cookies = parseCookies(header);
    return this.verifyToken(cookies[SESSION_COOKIE]);
  }

  userFromRequest(req) {
    return this.userFromCookieHeader(req.headers.cookie);
  }

  setSessionCookie(req, res, user) {
    const secure =
      req.secure || String(req.headers['x-forwarded-proto'] || '').split(',')[0] === 'https';
    const parts = [
      `${SESSION_COOKIE}=${encodeURIComponent(this.signToken(user))}`,
      'Path=/',
      'HttpOnly',
      'SameSite=Lax',
      `Max-Age=${Math.floor(SESSION_MAX_AGE / 1000)}`,
    ];
    if (secure) parts.push('Secure');
    res.setHeader('Set-Cookie', parts.join('; '));
  }

  clearSessionCookie(res) {
    res.setHeader(
      'Set-Cookie',
      `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`,
    );
  }

  canAccessAccount(user, accountId) {
    if (!user) return false;
    if (user.role === 'admin') return true;
    return Array.isArray(user.accounts)
      ? user.accounts.includes(accountId)
      : this.store.data.accounts.some((a) => a.id === accountId);
  }

  requireAuth = (req, res, next) => {
    const user = this.userFromRequest(req);
    if (!user) {
      res.status(401).json({ error: 'Silakan masuk terlebih dahulu.', code: 'UNAUTHORIZED' });
      return;
    }
    req.user = user;
    next();
  };

  requireAdmin = (req, res, next) => {
    if (req.user?.role !== 'admin') {
      res.status(403).json({ error: 'Hanya admin yang dapat melakukan tindakan ini.' });
      return;
    }
    next();
  };
}
