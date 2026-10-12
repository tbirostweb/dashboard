// Lecture seule des statistiques de fréquentation Umami (Cloud api.umami.is ou auto-hébergé).
// Appels exclusivement côté serveur : la clé API / le mot de passe ne parviennent jamais au navigateur.
// Les messages d'erreur ne contiennent ni URL ni secret (voir http.js).
import { fetchJson, ProviderError } from './http.js';

export const RANGES = { '7d': 7, '30d': 30, '12m': 365 };
export const DEFAULT_RANGE = '30d';
const DAY = 86_400_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Renvoie la liste des variables manquantes (vide = configuré). */
export function umamiMissing(c) {
  const missing = [];
  if (!c.baseUrl) missing.push('UMAMI_BASE_URL');
  if (!c.websiteId) missing.push('UMAMI_WEBSITE_ID');
  if (!c.apiKey && !(c.username && c.password)) missing.push('UMAMI_API_KEY (ou UMAMI_USERNAME + UMAMI_PASSWORD)');
  return missing;
}

/** Valeur numérique d'un champ de stats : nombre brut (anciennes versions) ou { value, prev }. */
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : v && typeof v.value === 'number' && Number.isFinite(v.value) ? v.value : null);
const prevOf = (stats, key) => {
  const v = stats[key];
  if (v && typeof v === 'object' && Number.isFinite(v.prev)) return v.prev;
  const c = stats.comparison && stats.comparison[key];
  return Number.isFinite(c) ? c : null;
};
const ratio = (a, b) => (Number.isFinite(a) && Number.isFinite(b) && b > 0 ? a / b : null);

export class UmamiClient {
  constructor(cfg, { fetch = globalThis.fetch, now = () => Date.now() } = {}) {
    this.cfg = cfg;
    this.fetch = fetch;
    this.now = now;
    this.token = null;
    this.login = null;
    this.cache = new Map();
  }

  get configured() { return umamiMissing(this.cfg).length === 0; }

  /** Racine de l'API : Cloud = {base}/v1 ; auto-hébergé = {base}/api. */
  get apiRoot() {
    const b = this.cfg.baseUrl;
    if (/\/(v1|api)$/.test(b)) return b;
    return this.cfg.apiKey && /^https:\/\/api\.umami\.is$/i.test(b) ? `${b}/v1` : `${b}/api`;
  }

  async headers({ fresh = false } = {}) {
    if (this.cfg.apiKey) return { 'x-umami-api-key': this.cfg.apiKey };
    if (!this.token || fresh) {
      // Une seule connexion à la fois : les requêtes simultanées attendent la même promesse.
      this.login ||= fetchJson(this.fetch, 'umami', `${this.apiRoot}/auth/login`, { method: 'POST', json: { username: this.cfg.username, password: this.cfg.password } })
        .then((r) => {
          if (!r || typeof r.token !== 'string') throw new ProviderError('umami', 'auth', 'Connexion Umami refusée : aucun jeton reçu.', 401);
          this.token = r.token;
        })
        .finally(() => { this.login = null; });
      await this.login;
    }
    return { Authorization: `Bearer ${this.token}` };
  }

  async get(path, params) {
    const url = `${this.apiRoot}/websites/${this.cfg.websiteId}${path}?${new URLSearchParams(params)}`;
    try {
      return await fetchJson(this.fetch, 'umami', url, { headers: await this.headers(), timeoutMs: 12_000 });
    } catch (err) {
      // Jeton expiré (mode identifiant / mot de passe) : une seule reconnexion.
      if (err instanceof ProviderError && err.status === 401 && !this.cfg.apiKey) {
        return fetchJson(this.fetch, 'umami', url, { headers: await this.headers({ fresh: true }), timeoutMs: 12_000 });
      }
      throw err;
    }
  }

  /** Rapport complet (cache court, requêtes simultanées dédupliquées). Lève ProviderError si les statistiques globales échouent. */
  report(range = DEFAULT_RANGE) {
    const ttl = (this.cfg.cacheSeconds ?? 300) * 1000;
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
    if (!UUID.test(this.cfg.websiteId)) throw new ProviderError('umami', 'config', 'UMAMI_WEBSITE_ID n’est pas un identifiant valide (format UUID, visible dans Umami > Paramètres du site).');
    const days = RANGES[range];
    const endAt = this.now();
    const startAt = endAt - days * DAY;
    const base = { startAt: String(startAt), endAt: String(endAt) };
    const unit = range === '12m' ? 'month' : 'day';
    const tz = this.cfg.timezone || 'UTC';
    const metrics = async (type, alt) => {
      try { return await this.get('/metrics', { ...base, type, limit: '10' }); } catch (err) {
        if (alt && err instanceof ProviderError && err.status === 400) return this.get('/metrics', { ...base, type: alt, limit: '10' }); // versions récentes : url → path
        throw err;
      }
    };
    const [stats, series, referrers, pages, active] = await Promise.allSettled([
      this.get('/stats', base),
      this.get('/pageviews', { ...base, unit, timezone: tz }),
      metrics('referrer'),
      metrics('path', 'url'),
      this.get('/active', {})
    ]);
    if (stats.status === 'rejected') throw stats.reason;

    const s = stats.value || {};
    const visits = num(s.visits), prevVisits = prevOf(s, 'visits');
    const totaltime = num(s.totaltime), bounces = num(s.bounces);
    const prevTotaltime = prevOf(s, 'totaltime'), prevBounces = prevOf(s, 'bounces');
    const avg = ratio(totaltime, visits), prevAvg = ratio(prevTotaltime, prevVisits);
    const bounce = ratio(bounces, visits), prevBounce = ratio(prevBounces, prevVisits);
    const kpi = (key) => ({ value: num(s[key]), previous: prevOf(s, key) });
    const list = (r) => (r.status === 'fulfilled' && Array.isArray(r.value) ? r.value.filter((x) => x && (typeof x.x === 'string' || x.x === null)).map((x) => ({ label: x.x || '', value: Number(x.y) || 0 })) : null);
    const points = (arr) => (Array.isArray(arr) ? arr.map((p) => ({ date: String(p.x).slice(0, 10), value: Number(p.y) || 0 })) : []);
    const a = active.status === 'fulfilled' ? active.value : null;
    const activeNow = typeof a === 'number' ? a : Array.isArray(a) ? Number(a[0] && (a[0].x ?? a[0].visitors)) : a && Number(a.visitors ?? a.x);

    return {
      range, days, unit, startAt, endAt, updatedAt: new Date(this.now()).toISOString(),
      totals: {
        visitors: kpi('visitors'), visits: { value: visits, previous: prevVisits }, pageviews: kpi('pageviews'),
        avgVisitSeconds: { value: avg, previous: prevAvg },
        bounceRate: { value: bounce === null ? null : bounce * 100, previous: prevBounce === null ? null : prevBounce * 100 }
      },
      active: Number.isFinite(activeNow) ? activeNow : null,
      series: series.status === 'fulfilled' ? points(series.value && series.value.pageviews) : null,
      sessions: series.status === 'fulfilled' ? points(series.value && series.value.sessions) : null,
      referrers: list(referrers),
      pages: list(pages)
    };
  }
}
