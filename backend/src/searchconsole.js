// Lecture seule de Google Search Console (API Search Analytics) via un compte de service.
// Appels exclusivement côté serveur ; la clé privée ne quitte jamais l'API. Aucune dépendance : JWT RS256 signé avec node:crypto.
// Les messages d'erreur ne contiennent ni URL, ni jeton, ni clé (voir http.js).
import crypto from 'node:crypto';
import { fetchJson, ProviderError } from './http.js';

export const GSC_RANGES = { '7d': 7, '30d': 30, '12m': 365 }; // mêmes périodes que l'onglet Visiteurs (Umami)
export const GSC_DEFAULT_RANGE = '30d';
const DAY = 86_400_000;
const SCOPE = 'https://www.googleapis.com/auth/webmasters.readonly';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const API = 'https://www.googleapis.com/webmasters/v3/sites';
const LAG_DAYS = 2; // Search Console publie ses données avec 2 à 3 jours de retard
const ymd = (ms) => new Date(ms).toISOString().slice(0, 10);

/** Propriété valide : « sc-domain:exemple.fr » (propriété de domaine) ou URL http(s) complète. */
export const gscSiteUrl = (v) => {
  const s = String(v || '').trim();
  return /^sc-domain:[a-z0-9.-]+$/i.test(s) || /^https?:\/\/[^\s]+$/i.test(s) ? s : '';
};
/** Clé PEM : les « \n » littéraux (variables d'environnement sur une ligne) redeviennent de vrais retours à la ligne. */
export const gscPrivateKey = (v) => String(v || '').replace(/\\n/g, '\n').trim();

export function gscMissing(c) {
  const missing = [];
  if (!c.siteUrl) missing.push('GSC_SITE_URL');
  if (!c.clientEmail) missing.push('GSC_CLIENT_EMAIL');
  if (!c.privateKey) missing.push('GSC_PRIVATE_KEY');
  return missing;
}

const fin = (v) => v !== null && v !== undefined && v !== '' && Number.isFinite(Number(v));
const b64u = (b) => Buffer.from(b).toString('base64url');

export class SearchConsoleClient {
  constructor(cfg, { fetch = globalThis.fetch, now = () => Date.now() } = {}) {
    this.cfg = cfg;
    this.fetch = fetch;
    this.now = now;
    this.token = null; // { value, exp }
    this.pending = null;
    this.cache = new Map();
  }

  get configured() { return gscMissing(this.cfg).length === 0; }

  async accessToken() {
    if (this.token && this.token.exp - 60_000 > this.now()) return this.token.value;
    this.pending ||= this.fetchToken().finally(() => { this.pending = null; });
    return this.pending;
  }

  async fetchToken() {
    const iat = Math.floor(this.now() / 1000);
    const claim = { iss: this.cfg.clientEmail, scope: SCOPE, aud: TOKEN_URL, iat, exp: iat + 3600 };
    const unsigned = `${b64u(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))}.${b64u(JSON.stringify(claim))}`;
    let assertion;
    try {
      assertion = `${unsigned}.${crypto.createSign('RSA-SHA256').update(unsigned).sign(this.cfg.privateKey, 'base64url')}`;
    } catch {
      throw new ProviderError('searchconsole', 'config', 'GSC_PRIVATE_KEY est illisible : collez la clé privée du fichier JSON du compte de service (« -----BEGIN PRIVATE KEY----- … »), avec les retours à la ligne écrits \\n.');
    }
    let r;
    try {
      r = await fetchJson(this.fetch, 'searchconsole', TOKEN_URL, { method: 'POST', form: { grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion } });
    } catch (err) {
      if (err instanceof ProviderError && err.code !== 'network') { err.code = 'auth'; err.stage = 'token'; }
      throw err;
    }
    if (!r || typeof r.access_token !== 'string') throw new ProviderError('searchconsole', 'auth', 'Google n’a renvoyé aucun jeton d’accès.', 401);
    this.token = { value: r.access_token, exp: this.now() + (Number(r.expires_in) || 3600) * 1000 };
    return this.token.value;
  }

  async query(body, retry = true) {
    const url = `${API}/${encodeURIComponent(this.cfg.siteUrl)}/searchAnalytics/query`;
    try {
      return await fetchJson(this.fetch, 'searchconsole', url, { method: 'POST', json: body, headers: { Authorization: `Bearer ${await this.accessToken()}` }, timeoutMs: 15_000 });
    } catch (err) {
      if (retry && err instanceof ProviderError && err.status === 401 && err.stage !== 'token') { this.token = null; return this.query(body, false); }
      throw err;
    }
  }

  report(range = GSC_DEFAULT_RANGE) {
    const ttl = (this.cfg.cacheSeconds ?? 600) * 1000;
    const hit = this.cache.get(range);
    if (hit && (hit.promise || this.now() - hit.at < ttl)) return hit.promise || Promise.resolve(hit.value);
    const promise = this.build(range).then(
      (value) => { this.cache.set(range, { at: this.now(), value }); return value; },
      (err) => { this.cache.delete(range); throw err; }
    );
    this.cache.set(range, { promise, at: 0 });
    return promise;
  }

  async build(range) {
    const days = GSC_RANGES[range];
    const end = this.now() - LAG_DAYS * DAY;
    const start = end - (days - 1) * DAY;
    const pEnd = start - DAY, pStart = pEnd - (days - 1) * DAY;
    const cur = { startDate: ymd(start), endDate: ymd(end) };
    const prev = { startDate: ymd(pStart), endDate: ymd(pEnd) };
    const [totals, previous, daily, queries, pages] = await Promise.allSettled([
      this.query({ ...cur }),
      this.query({ ...prev }),
      this.query({ ...cur, dimensions: ['date'], rowLimit: 1000 }),
      this.query({ ...cur, dimensions: ['query'], rowLimit: 25 }),
      this.query({ ...cur, dimensions: ['page'], rowLimit: 25 })
    ]);
    if (totals.status === 'rejected') throw totals.reason;

    const sum = (r) => {
      const row = r.status === 'fulfilled' && r.value && Array.isArray(r.value.rows) ? r.value.rows[0] : null;
      if (r.status !== 'fulfilled') return null;
      if (!row) return { clicks: 0, impressions: 0, ctr: null, position: null }; // aucune ligne = aucune impression sur la période
      return {
        clicks: fin(row.clicks) ? Number(row.clicks) : null, impressions: fin(row.impressions) ? Number(row.impressions) : null,
        ctr: fin(row.ctr) ? Number(row.ctr) * 100 : null, position: fin(row.position) ? Number(row.position) : null
      };
    };
    const c = sum(totals), p = sum(previous);
    const pair = (k) => ({ value: c[k], previous: p ? p[k] : null });
    const rows = (r, keyName) => (r.status === 'fulfilled' && r.value && (Array.isArray(r.value.rows) || r.value.rows === undefined)
      ? (r.value.rows || []).filter((x) => x && Array.isArray(x.keys) && fin(x.clicks) && fin(x.impressions)).map((x) => ({
        [keyName]: String(x.keys[0]), clicks: Number(x.clicks), impressions: Number(x.impressions),
        ctr: fin(x.ctr) ? Number(x.ctr) * 100 : null, position: fin(x.position) ? Number(x.position) : null
      })) : null);
    let series = null;
    if (daily.status === 'fulfilled' && daily.value && (Array.isArray(daily.value.rows) || daily.value.rows === undefined)) {
      const byDay = new Map((daily.value.rows || []).filter((x) => x && Array.isArray(x.keys) && fin(x.clicks) && fin(x.impressions)).map((x) => [x.keys[0], x]));
      series = [];
      for (let t = start; t <= end; t += DAY) { // un jour sans ligne = zéro impression
        const x = byDay.get(ymd(t));
        series.push({ date: ymd(t), clicks: x ? Number(x.clicks) : 0, impressions: x ? Number(x.impressions) : 0 });
      }
    }
    return {
      range, days, period: cur, previousPeriod: prev, updatedAt: new Date(this.now()).toISOString(),
      totals: { clicks: pair('clicks'), impressions: pair('impressions'), ctr: pair('ctr'), position: pair('position') },
      series, queries: rows(queries, 'query'), pages: rows(pages, 'page')
    };
  }
}
