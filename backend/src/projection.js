// Projection par liste blanche des objets `details` des fournisseurs : rien d'inconnu ne traverse l'API.
// Chaque schéma décrit explicitement les clés exposées et leur type ; le reste est ignoré.
import { sanitizeImageUrl } from './images.js';

const STR_MAX = 2000;
const finite = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const str = (v) => (typeof v === 'string' ? v.slice(0, STR_MAX) : null);

// Types : 's' texte, 'n' nombre, 'b' booléen, 'img' URL d'image assainie, 'p' primitif (texte/nombre/booléen),
// { o: {clé: type} } objet, { a: type, max } tableau, { m: type, max } dictionnaire (clés bornées).
// 'raw' : valeur JSON simple (URN de facettes non résolus, plages…) : primitifs et structures bornées, sans fonction.
function plain(v, depth = 0) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'string') return v.slice(0, 500);
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'boolean') return v;
  if (depth >= 3) return null;
  if (Array.isArray(v)) return v.slice(0, 100).map((x) => plain(x, depth + 1));
  if (typeof v === 'object') {
    const out = {};
    for (const k of Object.keys(v).slice(0, 50)) {
      if (/token|secret|password|authorization|cookie|api[_-]?key/i.test(k)) continue;
      out[k.slice(0, 80)] = plain(v[k], depth + 1);
    }
    return out;
  }
  return null;
}

export function project(schema, v) {
  if (v === null || v === undefined) return null;
  if (schema === 's') return str(v);
  if (schema === 'n') return finite(v);
  if (schema === 'b') return typeof v === 'boolean' ? v : null;
  if (schema === 'img') return sanitizeImageUrl(v);
  if (schema === 'p') return typeof v === 'string' ? str(v) : typeof v === 'number' ? finite(v) : typeof v === 'boolean' ? v : null;
  if (schema === 'raw') return plain(v);
  if (schema.a) return Array.isArray(v) ? v.slice(0, schema.max ?? 200).map((x) => project(schema.a, x)) : null;
  if (schema.m) {
    if (typeof v !== 'object' || Array.isArray(v)) return null;
    const out = {};
    for (const k of Object.keys(v).slice(0, schema.max ?? 50)) out[k.slice(0, 80)] = project(schema.m, v[k]);
    return out;
  }
  if (schema.o) {
    if (typeof v !== 'object' || Array.isArray(v)) return null;
    const out = {};
    for (const [k, t] of Object.entries(schema.o)) out[k] = project(t, v[k]);
    return out;
  }
  return null;
}

const NOTES = { a: 's', max: 50 };
const STATE = { state: 's', reason: 's' };

const INSTAGRAM = { o: {
  profile: { o: {
    username: 's', name: 's', accountType: 's', biography: 's', website: 's', profilePictureUrl: 'img',
    followersCount: 'n', followsCount: 'n', mediaCount: 'n'
  } },
  reels: { o: { count: 'n', avgWatchTimeSeconds: 'n', totalWatchTimeSeconds: 'n', skipRate: 'n' } },
  coverage: { o: { mediaFetched: 'n', insightsFetchedFor: 'n', commentsFetchedFor: 'n', truncated: 'b', windowDays: 'n' } },
  imageUrlsExpire: 'b',
  notes: NOTES
} };

const TIKTOK = { o: {
  profile: { o: {
    username: 's', displayName: 's', bio: 's', isVerified: 'b', avatarUrl: 'img', profileDeepLink: 's',
    followerCount: 'n', followingCount: 'n', likesCount: 'n', videoCount: 'n'
  } },
  coverage: { o: { videosFetched: 'n', windowDays: 'n', maxPages: 'n', truncated: 'b' } },
  cadence: { o: { postsPerWeek: 'n', lastPostAt: 's' } },
  imageUrlsExpire: 'b',
  notes: NOTES
} };

const FACET = { a: { o: { key: 'raw', count: 'n' } }, max: 100 };
const CLICKS = { a: { o: { type: 's', count: 'n' } }, max: 50 };
const BLOCK = { o: STATE };
const LINKEDIN = { o: {
  organization: { o: {
    name: 's', vanityName: 's', website: 's', description: 's', staffCountRange: 'raw', industries: 'raw',
    foundedOn: 'raw', type: 's', ...STATE
  } },
  followers: { o: {
    total: 'n', gains: { a: { o: { date: 's', organic: 'n', paid: 'n' } }, max: 400 },
    facets: { o: { association: FACET, country: FACET, function: FACET, seniority: FACET, industry: FACET, staffCount: FACET, region: FACET } },
    facetsTopN: 'n', latestDataDate: 's', ...STATE
  } },
  pageStats: { o: {
    daily: { a: { o: { date: 's', pageViews: 'n', uniqueVisitors: 'n' } }, max: 400 },
    bySection: { m: 'n', max: 10 }, byDevice: { m: 'n', max: 10 },
    total: { o: { pageViews: 'n', uniquePageViews: 'n' } },
    byCountry: FACET, byRegion: FACET, byFunction: FACET, bySeniority: FACET, byIndustry: FACET, byStaffCount: FACET,
    clicks: { o: { desktop: CLICKS, mobile: CLICKS } },
    window: { o: { start: 's', end: 's', granularity: 's' } },
    ...STATE
  } },
  reactionsByType: { m: 'n', max: 20 },
  reactionLabels: { m: 's', max: 20 },
  coverage: { o: { postsFetched: 'n', organicPosts: 'n', sponsoredExcluded: 'n', truncated: 'b', statsMeasuredFor: 'n', windowMonths: 'n' } },
  sponsoredPosts: { a: { o: { id: 's', platform: 's', type: 's', title: 's', publishedAt: 's', url: 's', sponsored: 'b', measured: 'b' } }, max: 100 },
  blocks: { m: BLOCK, max: 20 },
  budget: { o: { used: 'n', limit: 'n', resetsAt: 's' } },
  retention: { o: { commentsHours: 'n' } },
  notes: NOTES
} };

// Totaux des dernières 24 h (palier léger Instagram) : exposés seulement quand ils ont été lus.
const TODAY = { o: { windowHours: 'n', asOf: 's', views: 'n', total_interactions: 'n', likes: 'n', comments: 'n', shares: 'n', saves: 'n', reposts: 'n', profile_links_taps: 'n' } };

const SCHEMAS = { instagram: INSTAGRAM, tiktok: TIKTOK, linkedin: LINKEDIN };

/** Projette les `details` d'une plateforme ; null si absents. */
export function projectDetails(platform, details) {
  if (!details || typeof details !== 'object' || !SCHEMAS[platform]) return null;
  const out = project(SCHEMAS[platform], details);
  if (out && platform === 'instagram' && details.today) out.today = project(TODAY, details.today);
  return out;
}

/** Couverture de collecte normalisée (identique pour les trois plateformes, null si inconnue). */
export function coverageOf(platform, details) {
  const c = details && details.coverage;
  if (!c || typeof c !== 'object') return null;
  if (platform === 'instagram') {
    return { postsFetched: finite(c.mediaFetched), insightsFetchedFor: finite(c.insightsFetchedFor), commentsFetchedFor: finite(c.commentsFetchedFor), truncated: typeof c.truncated === 'boolean' ? c.truncated : null, windowDays: finite(c.windowDays) };
  }
  if (platform === 'tiktok') {
    return { postsFetched: finite(c.videosFetched), windowDays: finite(c.windowDays), maxPages: finite(c.maxPages), truncated: typeof c.truncated === 'boolean' ? c.truncated : null };
  }
  return {
    postsFetched: finite(c.postsFetched), organicPosts: finite(c.organicPosts), sponsoredExcluded: finite(c.sponsoredExcluded),
    statsMeasuredFor: finite(c.statsMeasuredFor), truncated: typeof c.truncated === 'boolean' ? c.truncated : null,
    windowDays: finite(c.windowMonths) === null ? null : c.windowMonths * 30, windowMonths: finite(c.windowMonths)
  };
}
