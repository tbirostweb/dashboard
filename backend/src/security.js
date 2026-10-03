// Session signée (cookie), anti brute-force, états OAuth anti-CSRF.
import { hmac, safeEqual, randomToken } from './crypto.js';

export const SESSION_COOKIE = 'sd_session';
export const OAUTH_COOKIE = 'sd_oauth';

// ---------------------------------------------------------------- Cookies
export function parseCookies(header = '') {
  const out = {};
  String(header).split(';').forEach((part) => {
    const i = part.indexOf('=');
    if (i < 0) return;
    const k = part.slice(0, i).trim();
    if (!k || k in out) return;
    try { out[k] = decodeURIComponent(part.slice(i + 1).trim()); } catch { out[k] = part.slice(i + 1).trim(); }
  });
  return out;
}

export function serializeCookie(name, value, { maxAge, secure, sameSite = 'Lax', path = '/', httpOnly = true } = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`, `Path=${path}`, `SameSite=${sameSite}`];
  if (httpOnly) parts.push('HttpOnly');
  if (secure) parts.push('Secure');
  if (maxAge !== undefined) {
    parts.push(`Max-Age=${Math.max(0, Math.floor(maxAge))}`);
    if (maxAge <= 0) parts.push('Expires=Thu, 01 Jan 1970 00:00:00 GMT');
  }
  return parts.join('; ');
}

// ---------------------------------------------------------------- Session signée
export function createSession(secret, ttlMs, now = Date.now()) {
  const payload = Buffer.from(JSON.stringify({ sid: randomToken(12), iat: now, exp: now + ttlMs })).toString('base64url');
  return `${payload}.${hmac(payload, secret)}`;
}

/** Renvoie le payload si la signature et l'expiration sont valides, sinon null. */
export function verifySession(value, secret, now = Date.now()) {
  if (typeof value !== 'string' || value.length > 1024) return null;
  const [payload, sig, extra] = value.split('.');
  if (!payload || !sig || extra !== undefined) return null;
  if (!safeEqual(sig, hmac(payload, secret))) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (!data || typeof data.exp !== 'number' || data.exp <= now) return null;
    return data;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- Anti brute-force
/**
 * Limite les échecs de connexion par IP et globalement (attaque distribuée).
 * Seuls les échecs comptent ; un succès remet le compteur de l'IP à zéro.
 */
export class LoginLimiter {
  constructor({ maxAttempts = 5, windowMs = 15 * 60_000, globalMax = 50, now = () => Date.now() } = {}) {
    Object.assign(this, { maxAttempts, windowMs, globalMax, now });
    this.byIp = new Map();
    this.global = [];
  }

  #prune(list) {
    const limit = this.now() - this.windowMs;
    while (list.length && list[0] <= limit) list.shift();
    return list;
  }

  /** Secondes restantes avant de pouvoir réessayer (0 = autorisé). */
  retryAfter(ip) {
    const list = this.#prune(this.byIp.get(ip) || []);
    const g = this.#prune(this.global);
    const blockedIp = list.length >= this.maxAttempts ? list[0] + this.windowMs - this.now() : 0;
    const blockedGlobal = g.length >= this.globalMax ? g[0] + this.windowMs - this.now() : 0;
    return Math.ceil(Math.max(blockedIp, blockedGlobal, 0) / 1000);
  }

  fail(ip) {
    const t = this.now();
    const list = this.byIp.get(ip) || [];
    list.push(t);
    this.byIp.set(ip, list);
    this.global.push(t);
    if (this.byIp.size > 10_000) this.byIp.clear(); // borne mémoire
  }

  succeed(ip) { this.byIp.delete(ip); }
}

// ---------------------------------------------------------------- États OAuth
/**
 * state OAuth : aléatoire, à usage unique, expire après 10 min, lié à la plateforme
 * et au navigateur (le même nonce est posé dans un cookie httpOnly SameSite=Lax).
 */
export class OAuthStates {
  constructor({ ttlMs = 10 * 60_000, now = () => Date.now() } = {}) {
    this.ttlMs = ttlMs;
    this.now = now;
    this.map = new Map();
  }

  create(platform, extra = {}) {
    this.#prune();
    const state = randomToken(24);
    const nonce = randomToken(16);
    this.map.set(state, { platform, nonce, expires: this.now() + this.ttlMs, ...extra });
    return { state, nonce };
  }

  /** Consomme le state (usage unique). Renvoie l'entrée si valide, sinon null. */
  consume(state, platform, nonce) {
    if (typeof state !== 'string' || !state) return null;
    const entry = this.map.get(state);
    this.map.delete(state);
    if (!entry || entry.expires <= this.now() || entry.platform !== platform) return null;
    if (!safeEqual(entry.nonce, nonce || '')) return null;
    return entry;
  }

  #prune() {
    const t = this.now();
    for (const [k, v] of this.map) if (v.expires <= t) this.map.delete(k);
    if (this.map.size > 1000) this.map.clear();
  }
}
