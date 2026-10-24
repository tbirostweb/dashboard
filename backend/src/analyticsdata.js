// Lecture seule de Google Analytics 4 (API Google Analytics Data, runReport) avec le MÊME compte de service que Search Console.
// Appels exclusivement côté serveur ; la clé privée ne quitte jamais l'API. Les messages d'erreur ne contiennent ni jeton ni clé.
// L'identifiant de mesure « G-XXXX » sert au script du site, pas à l'API : l'API demande l'identifiant NUMÉRIQUE de la propriété (GA4_PROPERTY_ID).
import { fetchJson, ProviderError } from './http.js';
import { SearchConsoleClient, GSC_RANGES, GSC_DEFAULT_RANGE } from './searchconsole.js';

export const GA4_RANGES = GSC_RANGES;
export const GA4_DEFAULT_RANGE = GSC_DEFAULT_RANGE;
const DAY = 86_400_000;
const SCOPE = 'https://www.googleapis.com/auth/analytics.readonly';
const ymd = (ms) => new Date(ms).toISOString().slice(0, 10);
const fin = (v) => v !== null && v !== undefined && v !== '' && Number.isFinite(Number(v));

/** « properties/123456789 » ou « 123456789 » → « 123456789 » ; autre chose (ex. G-XXXX) → ''. */
export const ga4PropertyId = (v) => { const m = String(v || '').trim().match(/^(?:properties\/)?(\d{5,15})$/); return m ? m[1] : ''; };

export function ga4Missing(gsc, ga4) {
  const missing = [];
  if (!ga4.propertyId) missing.push('GA4_PROPERTY_ID');
  if (!gsc.clientEmail) missing.push('GSC_CLIENT_EMAIL');
  if (!gsc.privateKey) missing.push('GSC_PRIVATE_KEY');
  return missing;
}

export class AnalyticsDataClient extends SearchConsoleClient {
  /** @param gsc  { clientEmail, privateKey } (compte de service partagé)   @param ga4 { propertyId, cacheSeconds } */
  constructor(gsc, ga4, deps = {}) {
    super({ ...gsc, cacheSeconds: ga4.cacheSeconds }, { ...deps, scope: SCOPE });
    this.ga4 = ga4;
  }

  get configured() { return ga4Missing(this.cfg, this.ga4).length === 0; }

  async run(body, retry = true) {
    const url = `https://analyticsdata.googleapis.com/v1beta/properties/${this.ga4.propertyId}:runReport`;
    try {
      return await fetchJson(this.fetch, 'analytics', url, { method: 'POST', json: body, headers: { Authorization: `Bearer ${await this.accessToken()}` }, timeoutMs: 15_000 });
    } catch (err) {
      if (retry && err instanceof ProviderError && err.status === 401 && err.stage !== 'token') { this.token = null; return this.run(body, false); }
      throw err;
    }
  }

  async build(range) {
    const days = GA4_RANGES[range];
    const end = this.now(), start = end - (days - 1) * DAY;
    const pEnd = start - DAY, pStart = pEnd - (days - 1) * DAY;
    const cur = [{ startDate: ymd(start), endDate: ymd(end) }], prev = [{ startDate: ymd(pStart), endDate: ymd(pEnd) }];
    const m = (...names) => names.map((name) => ({ name }));
    const totalsMetrics = m('activeUsers', 'sessions', 'screenPageViews', 'eventCount');
    const [totals, previous, daily, pages, events] = await Promise.allSettled([
      this.run({ dateRanges: cur, metrics: totalsMetrics }),
      this.run({ dateRanges: prev, metrics: totalsMetrics }),
      this.run({ dateRanges: cur, dimensions: [{ name: 'date' }], metrics: m('activeUsers', 'sessions', 'screenPageViews'), orderBys: [{ dimension: { dimensionName: 'date' } }], limit: 1000 }),
      this.run({ dateRanges: cur, dimensions: [{ name: 'pagePath' }], metrics: m('screenPageViews', 'activeUsers'), orderBys: [{ metric: { metricName: 'screenPageViews' }, desc: true }], limit: 25 }),
      this.run({ dateRanges: cur, dimensions: [{ name: 'eventName' }], metrics: m('eventCount', 'activeUsers'), orderBys: [{ metric: { metricName: 'eventCount' }, desc: true }], limit: 25 })
    ]);
    if (totals.status === 'rejected') throw totals.reason;

    const rowsOf = (r) => (r.status === 'fulfilled' && r.value && (Array.isArray(r.value.rows) || r.value.rows === undefined) ? r.value.rows || [] : null);
    const val = (row, i) => (row && row.metricValues && fin(row.metricValues[i] && row.metricValues[i].value) ? Number(row.metricValues[i].value) : null);
    const sum = (r) => {
      if (r.status !== 'fulfilled') return null;
      const row = rowsOf(r) && rowsOf(r)[0]; // aucune ligne = aucune activité sur la période
      return { users: row ? val(row, 0) : 0, sessions: row ? val(row, 1) : 0, pageviews: row ? val(row, 2) : 0, events: row ? val(row, 3) : 0 };
    };
    const c = sum(totals), p = sum(previous);
    const pair = (k) => ({ value: c[k], previous: p ? p[k] : null });
    const list = (r, key) => (rowsOf(r) === null ? null : rowsOf(r).filter((x) => x && x.dimensionValues && x.dimensionValues[0]).map((x) => ({
      [key]: String(x.dimensionValues[0].value), primary: val(x, 0), users: val(x, 1)
    })).filter((x) => x.primary !== null));
    let series = null;
    const dRows = rowsOf(daily);
    if (dRows) {
      const by = new Map(dRows.filter((x) => x.dimensionValues && /^\d{8}$/.test(x.dimensionValues[0].value)).map((x) => [x.dimensionValues[0].value, x]));
      series = [];
      for (let t = start; t <= end; t += DAY) { // jour sans ligne = aucune activité
        const d = ymd(t), row = by.get(d.replaceAll('-', ''));
        series.push({ date: d, users: row ? val(row, 0) : 0, sessions: row ? val(row, 1) : 0, pageviews: row ? val(row, 2) : 0 });
      }
    }
    return {
      range, days, period: { startDate: cur[0].startDate, endDate: cur[0].endDate }, updatedAt: new Date(this.now()).toISOString(),
      totals: { users: pair('users'), sessions: pair('sessions'), pageviews: pair('pageviews'), events: pair('events') },
      series,
      pages: list(pages, 'path')?.map((x) => ({ path: x.path, views: x.primary, users: x.users })) ?? null,
      events: list(events, 'name')?.map((x) => ({ name: x.name, count: x.primary, users: x.users })) ?? null
    };
  }
}
