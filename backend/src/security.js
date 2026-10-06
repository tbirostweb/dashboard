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

// ---------------------------------------------------------------- Registre serveur des sessions
/**
 * Une session n'est valide que si son identifiant (sid) figure dans ce registre EN MÉMOIRE :
 * - la déconnexion révoque le sid (une copie du cookie devient inutilisable) ;
 * - un redémarrage de l'API (rotation de SESSION_SECRET ou de DASHBOARD_PASSWORD via Redeploy) invalide toutes les sessions ;
 * - nombre de sessions simultanées borné (les plus anciennes sont évincées).
 */
export class SessionRegistry {
  constructor({ max = 20, now = () => Date.now() } = {}) {
    this.max = max;
    this.now = now;
    this.map = new Map(); // sid -> exp
  }

  add(sid, exp) {
    this.#prune();
    this.map.set(sid, exp);
    while (this.map.size > this.max) this.map.delete(this.map.keys().next().value);
  }

  has(sid) {
    const exp = this.map.get(sid);
    if (exp === undefined) return false;
    if (exp <= this.now()) { this.map.delete(sid); return false; }
    return true;
  }

  revoke(sid) { return this.map.delete(sid); }
  revokeAll() { this.map.clear(); }
  get size() { this.#prune(); return this.map.size; }

  #prune() {
    const t = this.now();
    for (const [k, exp] of this.map) if (exp <= t) this.map.delete(k);
  }
}

// ---------------------------------------------------------------- Appareil connu (cookie signé)
/**
 * Cookie posé après une connexion réussie : signé (HMAC, clé dérivée de SESSION_SECRET), sans donnée personnelle.
 * Il exempte l'appareil du blocage GLOBAL de connexion (jamais du quota par IP ni du mot de passe).
 */
export const DEVICE_COOKIE = 'sd_device';
export const DEVICE_TTL_MS = 180 * 86_400_000;
const deviceSig = (payload, secret) => hmac(`device:${payload}`, secret);

export function createDeviceToken(secret, now = Date.now()) {
  const payload = Buffer.from(JSON.stringify({ dev: randomToken(12), iat: now })).toString('base64url');
  return `${payload}.${deviceSig(payload, secret)}`;
}

/** true si le cookie d'appareil est authentique et a moins de maxAgeMs. */
export function verifyDeviceToken(value, secret, now = Date.now(), maxAgeMs = DEVICE_TTL_MS) {
  if (typeof value !== 'string' || value.length > 512) return false;
  const [payload, sig, extra] = value.split('.');
  if (!payload || !sig || extra !== undefined) return false;
  if (!safeEqual(sig, deviceSig(payload, secret))) return false;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return Boolean(data && typeof data.dev === 'string' && typeof data.iat === 'number' && data.iat <= now && now - data.iat < maxAgeMs);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------- Anti brute-force
/**
 * Limite les échecs de connexion par IP (blocage) et ralentit progressivement les réponses en échec.
 * Seuils globaux (attaque distribuée) : seuil élevé et configurable ; un échec n'y est compté que si
 * l'IP n'a pas déjà épuisé son propre quota ; les appareils connus (cookie signé) ne sont jamais
 * bloqués par la limite globale, ce qui empêche un anonyme de verrouiller l'administrateur.
 * Seuls les échecs comptent ; un succès remet le compteur de l'IP à zéro.
 */
export class LoginLimiter {
  constructor({ maxAttempts = 5, windowMs = 15 * 60_000, globalMax = 500, maxDelayMs = 5000, now = () => Date.now() } = {}) {
    Object.assign(this, { maxAttempts, windowMs, globalMax, maxDelayMs, now });
    this.byIp = new Map();
    this.global = [];
  }

  #prune(list) {
    const limit = this.now() - this.windowMs;
    while (list.length && list[0] <= limit) list.shift();
    return list;
  }

  /** Secondes restantes avant de pouvoir réessayer (0 = autorisé). knownDevice : exempté de la limite globale. */
  retryAfter(ip, { knownDevice = false } = {}) {
    const list = this.#prune(this.byIp.get(ip) || []);
    const g = this.#prune(this.global);
    const blockedIp = list.length >= this.maxAttempts ? list[0] + this.windowMs - this.now() : 0;
    const blockedGlobal = !knownDevice && g.length >= this.globalMax ? g[0] + this.windowMs - this.now() : 0;
    return Math.ceil(Math.max(blockedIp, blockedGlobal, 0) / 1000);
  }

  fail(ip) {
    const t = this.now();
    const list = this.#prune(this.byIp.get(ip) || []);
    // Une IP qui a déjà épuisé son quota n'alimente plus le compteur global.
    if (list.length < this.maxAttempts) this.global.push(t);
    list.push(t);
    this.byIp.set(ip, list);
    if (this.byIp.size > 10_000) this.byIp.clear(); // borne mémoire
    if (this.global.length > this.globalMax * 2) this.global.splice(0, this.global.length - this.globalMax * 2);
  }

  /**
   * Délai à appliquer à une réponse en ÉCHEC (ralentissement progressif) : base × 1, 2, 4, 8 selon les échecs
   * de l'IP, multiplié par 1 à 4 selon la pression globale ; plafonné à maxDelayMs. Une connexion réussie n'attend jamais.
   */
  failDelay(ip, baseMs) {
    if (!baseMs) return 0;
    const ipFails = this.#prune(this.byIp.get(ip) || []).length;
    const g = this.#prune(this.global).length;
    const ipFactor = 2 ** Math.min(Math.max(ipFails - 1, 0), 3);
    const globalFactor = 1 + Math.floor((3 * Math.min(g, this.globalMax)) / this.globalMax);
    return Math.min(this.maxDelayMs, baseMs * ipFactor * globalFactor);
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
