// Compteur d'appels sortants par plateforme (fenêtre glissante d'1 h, par minute) et suivi des en-têtes de quota Meta.
// Aucun contenu de requête ou de réponse n'est conservé : uniquement des nombres.
const MINUTE = 60_000;
const HOUR_BUCKETS = 60;
const USAGE_MAX_AGE_MS = 3_600_000;

/** Plateforme d'après l'hôte appelé (null = hôte non suivi, ex. Dokploy). */
export function platformOfUrl(url) {
  let host = '';
  try { host = new URL(String(url)).hostname.toLowerCase(); } catch { return null; }
  if (host.endsWith('instagram.com') || host.endsWith('facebook.com')) return 'instagram';
  if (host.endsWith('tiktokapis.com') || host.endsWith('tiktok.com')) return 'tiktok';
  if (host.endsWith('linkedin.com')) return 'linkedin';
  return null;
}

/** Pourcentage d'usage le plus élevé lisible dans X-App-Usage / X-Business-Use-Case-Usage, ou null. */
export function parseMetaUsage(headers) {
  const values = [];
  const grab = (v) => { if (typeof v === 'number' && Number.isFinite(v)) values.push(v); };
  const read = (raw) => {
    if (!raw) return;
    let json;
    try { json = JSON.parse(raw); } catch { return; }
    const scan = (o, depth = 0) => {
      if (!o || typeof o !== 'object' || depth > 4) return;
      if (Array.isArray(o)) { o.forEach((x) => scan(x, depth + 1)); return; }
      for (const k of ['call_count', 'total_time', 'total_cputime']) grab(o[k]);
      for (const v of Object.values(o)) if (v && typeof v === 'object') scan(v, depth + 1);
    };
    scan(json);
  };
  try { read(headers?.get?.('x-app-usage')); read(headers?.get?.('x-business-use-case-usage')); } catch { /* en-têtes illisibles : ignorés */ }
  return values.length ? Math.max(...values) : null;
}

export class CallMeter {
  constructor({ now = () => Date.now() } = {}) {
    this.now = now;
    this.buckets = new Map(); // plateforme -> Map(minute -> nombre)
    this.usage = new Map();   // plateforme -> { percent, at }
  }

  record(platform, n = 1) {
    if (!platform) return;
    const m = Math.floor(this.now() / MINUTE);
    const b = this.buckets.get(platform) || new Map();
    b.set(m, (b.get(m) || 0) + n);
    for (const k of b.keys()) if (k <= m - HOUR_BUCKETS) b.delete(k);
    this.buckets.set(platform, b);
  }

  /** Appels des 60 dernières minutes. */
  callsLastHour(platform) {
    const m = Math.floor(this.now() / MINUTE);
    let total = 0;
    for (const [k, v] of this.buckets.get(platform) || []) if (k > m - HOUR_BUCKETS) total += v;
    return total;
  }

  callsLastMinute(platform) {
    return (this.buckets.get(platform) || new Map()).get(Math.floor(this.now() / MINUTE)) || 0;
  }

  observeUsage(platform, percent) {
    if (percent === null || !Number.isFinite(percent)) return;
    this.usage.set(platform, { percent, at: this.now() });
  }

  /** Dernier pourcentage de quota observé (null si inconnu ou ancien). */
  usagePercent(platform) {
    const u = this.usage.get(platform);
    return u && this.now() - u.at <= USAGE_MAX_AGE_MS ? u.percent : null;
  }

  /** Enrobe un fetch : compte chaque requête sortante vers un fournisseur suivi et lit les en-têtes de quota. */
  wrap(fetchImpl) {
    return async (url, init) => {
      const platform = platformOfUrl(url);
      if (platform) this.record(platform);
      const res = await fetchImpl(url, init);
      if (platform === 'instagram') this.observeUsage(platform, parseMetaUsage(res.headers));
      return res;
    };
  }
}

/** Facteur de ralentissement automatique selon le quota observé : 1 (normal), 2 au-delà de 70 %, 4 au-delà de 90 %. */
export function slowdownFactor(percent) {
  if (percent === null || percent === undefined) return 1;
  if (percent >= 90) return 4;
  if (percent >= 70) return 2;
  return 1;
}
