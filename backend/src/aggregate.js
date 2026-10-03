// Calculs identiques à js/api.js (version mock), côté serveur.
// Entrée : un "dataset" au format de data/mock.js : { accounts, daily, posts, comments }.
// Sortie : exactement les formes que les vues de js/app.js consomment.
import { isoDay } from './util.js';
import { sanitizeImageUrl, sanitizeLinkUrl } from './images.js';
import { coverageOf } from './projection.js';

export const PLATFORMS = ['tiktok', 'instagram', 'linkedin'];
export const VIEW_LABELS = { tiktok: 'Vues', instagram: 'Portée', linkedin: 'Impressions' };
export const DAYS = 190;

const sum = (arr, k) => arr.some((x) => Number.isFinite(x[k])) ? arr.reduce((s, x) => s + (x[k] || 0), 0) : null;
const interactions = (x) => (x.likes || 0) + (x.comments || 0) + (x.shares || 0) + (x.saves || 0);
const fin = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const round2 = (v) => Math.round(v * 100) / 100;

// Taux d'engagement par publication : TOUJOURS en pourcentage (0..100+), null si inconnu (jamais 0 par défaut).
export const ENGAGEMENT_BASIS = {
  instagram: "(j'aime + commentaires + partages + enregistrements si connus) ÷ portée de la publication × 100. Inconnu si la portée n'est pas fournie par Instagram.",
  tiktok: "(j'aime + commentaires + partages) ÷ vues × 100. TikTok ne fournit pas les enregistrements.",
  linkedin: "Taux fourni par l'API LinkedIn (clics + réactions + commentaires + partages ÷ impressions) × 100. Inconnu si la publication n'est pas mesurée."
};
export const KPI_ENGAGEMENT_BASIS = {
  instagram: "Interactions de la période ÷ portée quotidienne du compte (ou, à défaut, portée des publications) × 100.",
  tiktok: "Interactions de la période ÷ vues des vidéos publiées pendant la période × 100.",
  linkedin: "Interactions de la période ÷ impressions de la Page sur la période × 100."
};
export const GLOBAL_ENGAGEMENT_BASIS = "Taux pondéré : total des interactions (j'aime, commentaires, partages, enregistrements si connus) ÷ total des audiences des publications de la période (portée Instagram, vues TikTok, impressions LinkedIn) × 100. Seules les publications dont l'audience est connue sont comptées.";

/** Interactions connues d'une publication (null si aucune composante n'est connue). */
function knownInteractions(p) {
  const parts = [p.likes, p.comments, p.shares, p.saves].filter((v) => fin(v) !== null);
  return parts.length ? parts.reduce((s, v) => s + v, 0) : null;
}

/** Audience de référence du taux d'engagement : portée (Instagram), vues (TikTok), impressions (LinkedIn). */
function audienceOf(p) {
  if (p.platform === 'instagram') return fin(p.reach);
  if (p.platform === 'tiktok') return fin(p.views);
  if (p.platform === 'linkedin') return fin(p.impressions) ?? null;
  return null;
}

function postEngagement(p) {
  if (p.platform === 'linkedin') return fin(p.engagementRate); // déjà en pourcentage côté fournisseur
  const base = audienceOf(p);
  const inter = knownInteractions(p);
  return base > 0 && inter !== null ? round2((inter / base) * 100) : null;
}

const INSTAGRAM_EXTRA = ['reach', 'viewsCount', 'reposts', 'totalInteractions', 'profileVisits', 'follows', 'avgWatchTimeSeconds', 'totalWatchTimeSeconds', 'skipRate'];
const LINKEDIN_EXTRA = ['impressions', 'uniqueImpressions', 'clicks', 'reactions'];

/**
 * Publication exposée par l'API : projection explicite (aucun champ fournisseur inconnu ne passe).
 * Rétrocompatible : id, platform, type, title, publishedAt, views, likes, comments, shares, saves, url, interactions, engagementRate.
 */
export function publicPost(p) {
  const out = {
    id: String(p.id), platform: p.platform, type: p.type ?? null, title: typeof p.title === 'string' ? p.title.slice(0, 300) : '',
    publishedAt: p.publishedAt,
    views: fin(p.views), likes: fin(p.likes), comments: fin(p.comments), shares: fin(p.shares),
    saves: p.platform === 'linkedin' ? null : fin(p.saves), // LinkedIn ne fournit aucun enregistrement : inconnu, pas 0
    url: sanitizeLinkUrl(p.url),
    imageUrl: sanitizeImageUrl(p.thumbnailUrl ?? p.coverUrl ?? p.imageUrl),
    imageUrlsExpire: Boolean(p.imageUrlsExpire ?? (p.thumbnailUrl || p.coverUrl)),
    interactions: knownInteractions({ ...p, saves: p.platform === 'linkedin' ? null : p.saves }),
    engagementRate: postEngagement(p),
    engagementBasis: ENGAGEMENT_BASIS[p.platform] || null
  };
  if (p.platform === 'instagram') {
    out.productType = typeof p.productType === 'string' ? p.productType : null;
    INSTAGRAM_EXTRA.forEach((k) => { out[k] = fin(p[k]); });
  } else if (p.platform === 'tiktok') {
    out.durationSeconds = fin(p.durationSeconds);
    out.durationBucket = typeof p.durationBucket === 'string' ? p.durationBucket : null;
  } else if (p.platform === 'linkedin') {
    LINKEDIN_EXTRA.forEach((k) => { out[k] = fin(p[k]); });
    out.measured = typeof p.measured === 'boolean' ? p.measured : null;
    out.sponsored = typeof p.sponsored === 'boolean' ? p.sponsored : false;
    out.reactionsByType = p.reactionsByType && typeof p.reactionsByType === 'object'
      ? Object.fromEntries(Object.entries(p.reactionsByType).slice(0, 20).filter(([, v]) => fin(v) !== null)) : null;
  }
  return out;
}
export const clampPeriod = (p) => ([7, 30, 90].includes(Number(p)) ? Number(p) : 30);

function windows(series, period) {
  const n = series.length;
  return { current: series.slice(n - period), previous: series.slice(Math.max(0, n - 2 * period), n - period) };
}

function periodStart(daily, period) {
  const cur = daily.slice(-period);
  return new Date(cur[0].date + 'T00:00:00');
}

function kpisFromDaily(cur, prev) {
  const agg = (arr) => {
    const t = { likes: sum(arr, 'likes'), comments: sum(arr, 'comments'), shares: sum(arr, 'shares'), views: sum(arr, 'views') };
    t.interactions = [t.likes,t.comments,t.shares].some(Number.isFinite) ? (t.likes || 0) + (t.comments || 0) + (t.shares || 0) : null;
    t.engagementRate = t.views ? (t.interactions / t.views) * 100 : null;
    return t;
  };
  const a = agg(cur), b = agg(prev);
  const last = (arr) => (arr.length ? arr[arr.length - 1].followers : null);
  return {
    followers: { value: last(cur), previous: last(prev) },
    likes: { value: a.likes, previous: b.likes },
    comments: { value: a.comments, previous: b.comments },
    shares: { value: a.shares, previous: b.shares },
    views: { value: a.views, previous: b.views },
    engagementRate: { value: a.engagementRate, previous: b.engagementRate }
  };
}

function sumKpis(list) {
  const out = {};
  ['followers', 'likes', 'comments', 'shares', 'views'].forEach((k) => {
    const total = (w) => list.some((x) => Number.isFinite(x[k][w])) ? list.reduce((s, x) => s + (x[k][w] || 0), 0) : null;
    out[k] = { value: total('value'), previous: total('previous') };
  });
  const inter = (w) => out.likes[w] + out.comments[w] + out.shares[w];
  out.engagementRate = {
    value: out.views.value ? inter('value') / out.views.value * 100 : null,
    previous: out.views.previous ? inter('previous') / out.views.previous * 100 : null
  };
  return out;
}


/** Liste des N dernières dates (fuseau du serveur), de la plus ancienne à aujourd'hui. */
export function lastDates(days = DAYS, now = Date.now()) {
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  return Array.from({ length: days }, (_, i) => {
    const d = new Date(today);
    d.setDate(d.getDate() - (days - 1 - i));
    return isoDay(d);
  });
}

/** Série journalière vide (plateforme non connectée). */
export const emptyDaily = (dates) => dates.map((date) => ({ date, followers: null, newFollowers: null, views: null, likes: null, comments: null, shares: null }));

/**
 * Construit la série journalière d'une plateforme réelle.
 * - vues : insight quotidien du compte si disponible, sinon somme des vues des publications du jour
 * - j'aime / commentaires / partages : attribués au jour de publication (les API ne donnent que des totaux par post)
 * - followers : valeur actuelle, puis reconstruction à rebours via instantanés (snapshots) et gains quotidiens
 */
export function buildDaily(raw, snapshots = {}, dates = lastDates()) {
  const byDay = new Map(dates.map((d) => [d, { views: null, likes: null, comments: null, shares: null }]));
  (raw.posts || []).forEach((p) => {
    const e = byDay.get(isoDay(p.publishedAt));
    if (!e) return;
    for (const key of ['views', 'likes', 'comments', 'shares']) if (Number.isFinite(p[key])) e[key] = (e[key] || 0) + p[key];
  });
  const dv = raw.dailyViews || {};
  const dnf = raw.dailyNewFollowers || {};

  const n = dates.length;
  const followers = dates.map((date) => Number.isFinite(snapshots[date]) ? snapshots[date] : null);
  if (Number.isFinite(raw.followers)) followers[n - 1] = raw.followers;

  return dates.map((date, i) => {
    const e = byDay.get(date);
    return {
      date,
      followers: followers[i],
      newFollowers: Number.isFinite(dnf[date]) ? dnf[date] : (i > 0 && followers[i] !== null && followers[i - 1] !== null ? followers[i] - followers[i - 1] : null),
      views: Number.isFinite(dv[date]) ? dv[date] : e.views,
      likes: e.likes,
      comments: e.comments,
      shares: e.shares
    };
  });
}

// ------------------------------------------------------------------ Vues (mêmes formes que js/api.js)

export function accounts(d) {
  return PLATFORMS.map((p) => d.accounts[p]);
}

const periodLabelOf = (period) => `vs ${period} j précédents`;

/** KPI avec comparaison : delta = variation relative en % (ou écart en points pour un taux), null sans comparaison. */
export function makeKpi(value, previous, { unit = 'percent', period, reason = null } = {}) {
  value = fin(value);
  previous = value === null ? null : fin(previous);
  let delta = null;
  let why = null;
  if (value === null) why = reason || 'Donnée indisponible.';
  else if (previous === null) why = reason || 'Historique insuffisant pour comparer.';
  else if (unit === 'percent') {
    if (previous === 0) why = 'Période précédente à 0 : variation relative non calculable.';
    else delta = round2(((value - previous) / previous) * 100);
  } else delta = round2(value - previous);
  return { value, previous, delta, deltaUnit: unit, periodLabel: periodLabelOf(period), reason: delta === null ? why : null };
}

const isLive = (d, p) => ['connected', 'limited'].includes(d.platforms && d.platforms[p] && d.platforms[p].status);

function windowPosts(d, p, from, to) {
  return d.posts.filter((x) => x.platform === p && new Date(x.publishedAt) >= from && (!to || new Date(x.publishedAt) < to));
}

function sumInteractions(list) {
  const known = list.map(knownInteractions).filter((v) => v !== null);
  return known.length ? known.reduce((a, b) => a + b, 0) : (list.length ? null : 0);
}

/** { inter, base } sur les seules publications dont l'audience est connue (> 0). */
function engagementParts(list) {
  let inter = 0; let base = 0; let n = 0;
  list.forEach((x) => {
    const a = audienceOf(x); const i = knownInteractions(x);
    if (a > 0 && i !== null) { inter += i; base += a; n++; }
  });
  return { inter, base, n };
}
const rateOf = ({ inter, base }) => (base > 0 ? round2((inter / base) * 100) : null);

/** La période précédente est-elle couverte par la collecte ? { ok, reason } */
function previousCoverage(d, p, period) {
  const cov = coverageOf(p, d.details && d.details[p]);
  const days = cov && cov.windowDays;
  if (cov && cov.truncated === true) return { ok: false, reason: 'Historique insuffisant : collecte partielle (plafond de pages atteint), la période précédente est incomplète.' };
  if (!Number.isFinite(days)) return { ok: false, reason: 'Historique insuffisant : étendue de la collecte inconnue.' };
  if (days < 2 * period) return { ok: false, reason: `Historique insuffisant : la collecte couvre ${days} j, la comparaison en demande ${2 * period}.` };
  return { ok: true, reason: null };
}

const NOT_LIVE_REASON = { not_connected: 'Plateforme non connectée.', pending_approval: "En attente d'approbation de la plateforme.", expired: 'Jeton expiré : reconnectez le compte.', error: 'Plateforme en erreur.' };

/** KPI par plateforme et totaux inter-réseaux, uniquement à partir des données déjà présentes. */
function buildKpis(d, period) {
  const n = d.daily.tiktok.length;
  const start = periodStart(d.daily.tiktok, period);
  const prevStart = new Date(start); prevStart.setDate(prevStart.getDate() - period);
  const byPlatform = {};
  const live = [];
  PLATFORMS.forEach((p) => {
    const status = d.platforms && d.platforms[p] ? d.platforms[p].status : 'not_connected';
    const daily = d.daily[p];
    if (!isLive(d, p)) {
      const reason = (d.platforms && d.platforms[p] && d.platforms[p].message) || NOT_LIVE_REASON[status] || 'Donnée indisponible.';
      byPlatform[p] = { status, followers: makeKpi(null, null, { period, reason }), interactions: makeKpi(null, null, { period, reason }), engagementRate: makeKpi(null, null, { unit: 'points', period, reason }) };
      return;
    }
    const first = daily.find((x) => fin(x.followers) !== null);
    const fValue = fin(daily[n - 1].followers);
    const fPrev = n - period - 1 >= 0 ? fin(daily[n - period - 1].followers) : null;
    const fReason = first ? `Historique insuffisant : premier relevé le ${first.date}.` : 'Historique insuffisant : aucun relevé de followers.';
    const cur = windowPosts(d, p, start);
    const prev = windowPosts(d, p, prevStart, start);
    const cov = previousCoverage(d, p, period);
    const iCur = sumInteractions(cur);
    const iPrev = cov.ok ? sumInteractions(prev) : null;
    const eCur = engagementParts(cur);
    const ePrev = cov.ok ? engagementParts(prev) : null;
    byPlatform[p] = {
      status,
      followers: makeKpi(fValue, fPrev, { period, reason: fReason }),
      interactions: makeKpi(iCur, iPrev, { period, reason: cov.reason }),
      engagementRate: makeKpi(rateOf(eCur), ePrev ? rateOf(ePrev) : null, { unit: 'points', period, reason: cov.ok ? 'Période précédente sans audience connue.' : cov.reason })
    };
    live.push({ p, fValue, fPrev, fReason, iCur, iPrev, eCur, ePrev, covReason: cov.reason, covOk: cov.ok });
  });

  let totals;
  if (!live.length) {
    const reason = 'Aucune plateforme connectée.';
    totals = { followers: makeKpi(null, null, { period, reason }), interactions: makeKpi(null, null, { period, reason }), engagementRate: makeKpi(null, null, { unit: 'points', period, reason }) };
  } else {
    const total = (key) => {
      const vals = live.map((x) => x[key]).filter((v) => v !== null);
      return vals.length ? vals.reduce((a, b) => a + b, 0) : null;
    };
    // Une comparaison n'a de sens que si TOUTES les plateformes incluses ont une valeur précédente
    const allPrev = (key) => (live.every((x) => x[key] !== null) ? total(key) : null);
    const missingF = live.filter((x) => x.fPrev === null).map((x) => x.p);
    const missingI = live.filter((x) => x.iPrev === null);
    const eAll = engagementParts(live.flatMap((x) => windowPosts(d, x.p, start)));
    const ePrevAll = live.every((x) => x.covOk) ? engagementParts(live.flatMap((x) => windowPosts(d, x.p, prevStart, start))) : null;
    totals = {
      followers: makeKpi(total('fValue'), allPrev('fPrev'), { period, reason: `Historique insuffisant : relevés précédents manquants (${missingF.join(', ')}). ${(live.find((x) => x.fPrev === null) || {}).fReason || ''}`.trim() }),
      interactions: makeKpi(total('iCur'), allPrev('iPrev'), { period, reason: (missingI[0] && missingI[0].covReason) || 'Historique insuffisant pour comparer.' }),
      engagementRate: makeKpi(rateOf(eAll), ePrevAll ? rateOf(ePrevAll) : null, { unit: 'points', period, reason: (live.find((x) => !x.covOk) || {}).covReason || 'Période précédente sans audience connue.' })
    };
    totals.engagementRate.basis = GLOBAL_ENGAGEMENT_BASIS;
    totals.engagementRate.unit = '%';
    totals.engagementRate.postsCounted = eAll.n;
    totals.interactions.basis = "Somme des interactions connues (j'aime, commentaires, partages, enregistrements si fournis) des publications de la période.";
    totals.followers.basis = 'Somme des abonnés actuels des plateformes connectées.';
    totals.includedPlatforms = live.map((x) => x.p);
  }
  PLATFORMS.forEach((p) => { if (byPlatform[p].engagementRate) byPlatform[p].engagementRate.basis = ENGAGEMENT_BASIS[p]; });
  return { totals, byPlatform };
}

export function overview(d, period) {
  period = clampPeriod(period);
  const perPlatform = {};
  const series = { dates: d.daily.tiktok.slice(-period).map((x) => x.date), interactions: {} };
  const distribution = {};
  PLATFORMS.forEach((p) => {
    const { current, previous } = windows(d.daily[p], period);
    perPlatform[p] = kpisFromDaily(current, previous);
    series.interactions[p] = current.map((x) => [x.likes,x.comments,x.shares].some(Number.isFinite) ? (x.likes || 0) + (x.comments || 0) + (x.shares || 0) : null);
    distribution[p] = series.interactions[p].some(Number.isFinite) ? series.interactions[p].reduce((s, v) => s + (v || 0), 0) : null;
  });
  const start = periodStart(d.daily.tiktok, period);
  const inPeriod = d.posts.filter((p) => new Date(p.publishedAt) >= start).map(publicPost);
  // topPosts = meilleures publications de la période (interactions décroissantes) ; latestPosts = les plus récentes
  const topPosts = [...inPeriod].sort((a, b) => (b.interactions ?? -1) - (a.interactions ?? -1)).slice(0, 6);
  const latestPosts = [...inPeriod].sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt)).slice(0, 6);
  const { totals, byPlatform } = buildKpis(d, period);
  return { period, kpis: sumKpis(Object.values(perPlatform)), perPlatform, series, distribution, topPosts, latestPosts, totals, kpisByPlatform: byPlatform };
}

export function platformStats(d, platform, period) {
  period = clampPeriod(period);
  const { current, previous } = windows(d.daily[platform], period);
  const start = periodStart(d.daily[platform], period);
  const posts = d.posts.filter((p) => p.platform === platform && new Date(p.publishedAt) >= start).map((p) => ({ ...p, interactions: interactions(p) }));

  const group = (keyFn, keys) => {
    const m = new Map(keys.map((k) => [k, { key: k, posts: 0, interactions: 0, views: 0 }]));
    posts.forEach((p) => {
      const k = keyFn(p);
      if (!m.has(k)) m.set(k, { key: k, posts: 0, interactions: 0, views: 0 });
      const g = m.get(k); g.posts++; g.interactions += p.interactions; g.views += p.views;
    });
    return [...m.values()].map((g) => ({
      ...g,
      avgInteractions: g.posts ? Math.round(g.interactions / g.posts) : 0,
      engagementRate: g.views ? g.interactions / g.views * 100 : 0
    }));
  };

  return {
    platform,
    period,
    account: d.accounts[platform],
    viewLabel: VIEW_LABELS[platform],
    engagementBasis: ENGAGEMENT_BASIS[platform],
    kpiEngagementBasis: KPI_ENGAGEMENT_BASIS[platform],
    kpis: kpisFromDaily(current, previous),
    postsCount: posts.length,
    series: {
      dates: current.map((x) => x.date),
      followers: current.map((x) => x.followers),
      newFollowers: current.map((x) => x.newFollowers),
      views: current.map((x) => x.views),
      likes: current.map((x) => x.likes),
      comments: current.map((x) => x.comments),
      shares: current.map((x) => x.shares)
    },
    byType: group((p) => p.type, []).sort((a, b) => b.engagementRate - a.engagementRate),
    byHour: group((p) => Math.floor(new Date(p.publishedAt).getHours() / 3) * 3, [0, 3, 6, 9, 12, 15, 18, 21]).sort((a, b) => a.key - b.key)
  };
}

const SORT_KEYS = ['publishedAt', 'views', 'likes', 'comments', 'shares', 'engagementRate', 'interactions', 'saves', 'reach', 'impressions', 'viewsCount'];

export function posts(d, { platform, period, sort = 'publishedAt', limit } = {}) {
  period = clampPeriod(period);
  if (!SORT_KEYS.includes(sort)) sort = 'publishedAt';
  const start = periodStart(d.daily.tiktok, period);
  const list = d.posts
    .filter((p) => (!platform || p.platform === platform) && new Date(p.publishedAt) >= start)
    .map(publicPost);
  const dir = sort === 'publishedAt' ? (a, b) => new Date(b.publishedAt) - new Date(a.publishedAt) : (a, b) => (b[sort] ?? -1) - (a[sort] ?? -1);
  list.sort(dir);
  const n = Number(limit);
  return n > 0 ? list.slice(0, n) : list;
}

export function comments(d, { platform = '', sentiment = '', q = '', period, limit } = {}) {
  period = clampPeriod(period);
  const start = periodStart(d.daily.tiktok, period);
  const postsById = new Map(d.posts.map((p) => [p.id, p]));
  const needle = String(q || '').trim().toLocaleLowerCase('fr');
  let list = d.comments
    .filter((c) => new Date(c.createdAt) >= start)
    .filter((c) => !platform || c.platform === platform)
    .filter((c) => !sentiment || c.sentiment === sentiment)
    .map((c) => {
      const p = postsById.get(c.postId);
      return { ...c, post: p ? { id: c.postId, title: p.title, type: p.type } : null };
    })
    .filter((c) => !needle || [c.text, c.author, c.handle, c.post && c.post.title].some((s) => s && s.toLocaleLowerCase('fr').includes(needle)))
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  const stats = { total: list.length, positive: 0, neutral: 0, negative: 0 };
  list.forEach((c) => { if (c.sentiment in stats) stats[c.sentiment]++; });
  const n = Number(limit);
  if (n > 0) list = list.slice(0, n);
  return { stats, items: list };
}
