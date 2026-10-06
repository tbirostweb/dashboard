// Connecteur Instagram : « Instagram API with Instagram Login » (compte professionnel : Business ou Créateur).
// Doc : https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login
// Token court (1 h) → échangé contre un token long (60 j) → rafraîchi (ig_refresh_token) avant expiration.
import { fetchJson, ProviderError } from '../http.js';
import { mapLimit, titleFrom, toIso, num, isoDay } from '../util.js';
import { sentiment } from '../sentiment.js';

const AUTH_URL = 'https://www.instagram.com/oauth/authorize';
const TOKEN_URL = 'https://api.instagram.com/oauth/access_token';
const GRAPH = 'https://graph.instagram.com';
/** paging.next n'est suivi que vers https://graph.instagram.com (jamais vers un hôte étranger : le jeton y figure). */
export const isGraphPagingUrl = (next) => {
  try { const u = new URL(String(next)); return u.protocol === 'https:' && u.host === 'graph.instagram.com'; } catch { return false; }
};
const HISTORY_DAYS = 190;
const MAX_MEDIA_PAGES = 5;
// Plafonds par défaut (surchargeables via cfg.instagram.insightMediaMax / commentMediaMax / insightConcurrency).
// Quota Meta : 4800 × impressions du compte / 24 h ; ~120 médias × 1 appel reste très en dessous.
const INSIGHT_MEDIA = 120;      // nb max de médias dont on lit les insights
const COMMENT_MEDIA = 30;       // nb max de médias dont on lit les commentaires
const INSIGHT_CONCURRENCY = 5;
const COMMENT_CONCURRENCY = 6;
/** ig_reels_avg_watch_time et ig_reels_video_view_total_time sont renvoyés en MILLISECONDES (doc Meta, Media Insights). */
export const MS_PER_SECOND = 1000;
const MEDIA_BASE = 'id,caption,media_type,media_product_type,permalink,timestamp,like_count,comments_count';
const MEDIA_VISUAL = 'media_url,thumbnail_url,shortcode,is_shared_to_feed,media_audio_type';
const MEDIA_COUNTS = 'reposts_count,saved_count,shares_count,total_like_count,total_comments_count,total_views_count';
// Métriques d'insights par type de média (impressions, plays, video_views supprimées par Meta : jamais demandées).
const FEED_METRICS = ['reach', 'views', 'likes', 'comments', 'shares', 'saved', 'reposts', 'total_interactions', 'profile_visits', 'follows'];
const REELS_METRICS = ['reach', 'views', 'likes', 'comments', 'shares', 'saved', 'reposts', 'total_interactions', 'ig_reels_avg_watch_time', 'ig_reels_video_view_total_time', 'reels_skip_rate'];
const METRIC_TIERS = (full) => [
  full,
  full.filter((m) => !['profile_visits', 'follows', 'ig_reels_avg_watch_time', 'ig_reels_video_view_total_time', 'reels_skip_rate', 'reposts'].includes(m)),
  ['reach', 'saved', 'shares', 'views'],
  ['reach', 'saved', 'shares'],
  ['reach']
];
const PRODUCT_TYPES = new Set(['FEED', 'REELS', 'STORY']);
const nn = (v) => (v === undefined || v === null || !Number.isFinite(Number(v)) ? null : Number(v));
const DAY = 86_400_000;

const TYPE = (m) => (m.media_product_type === 'REELS' ? 'Reel'
  : m.media_type === 'CAROUSEL_ALBUM' ? 'Carrousel'
    : m.media_type === 'VIDEO' ? 'Vidéo'
      : m.media_type === 'IMAGE' ? 'Photo' : 'Publication');

/** Lit une valeur d'insight, qu'elle soit sous values[0].value ou total_value.value. */
function insightValue(entry) {
  if (!entry) return undefined;
  if (entry.total_value && entry.total_value.value !== undefined) return num(entry.total_value.value);
  if (Array.isArray(entry.values) && entry.values.length) return num(entry.values[entry.values.length - 1].value);
  return undefined;
}

// ------------------------------------------------------------------ Insights du compte
// Référence (vérifiée le 01/10/2026) : https://developers.facebook.com/docs/instagram-platform/api-reference/instagram-user/insights
// Toutes ces métriques : metric_type=total_value, period=day. Supprimées par Meta (non demandées) : impressions,
// profile_views, website_clicks, email_contacts, phone_call_clicks, text_message_clicks, get_directions_clicks.
const MAX_RANGE_S = 30 * 86400;                 // fenêtre since/until prudente (Meta refuse les plages > 30 j)
export const ADDITIVE = ['views', 'total_interactions', 'likes', 'comments', 'shares', 'saves', 'reposts', 'replies', 'profile_links_taps'];
export const UNIQUES = ['reach', 'accounts_engaged']; // comptes uniques : non additionnables entre fenêtres
export const DEMO_THRESHOLD = 100;              // follower_demographics / online_followers : 100 followers minimum
const DEMO_BREAKDOWNS = ['age', 'gender', 'country', 'city'];
const ENGAGED_TIMEFRAME = { 7: 'this_week', 30: 'last_30_days', 90: 'last_90_days' };
const CONTENT_LABELS = { REEL: 'Reels', POST: 'Publications', CAROUSEL_CONTAINER: 'Carrousels', STORY: 'Stories', AD: 'Publicités', IGTV: 'Vidéos', UNKNOWN: 'Autre' };
const BUTTON_LABELS = { DIRECTION: "Adresse de l'entreprise", CALL: 'Appeler', EMAIL: 'E-mail', TEXT: 'SMS', BOOK_NOW: 'Réserver', INSTANT_EXPERIENCE: 'Expérience instantanée', UNDEFINED: 'Autre' };
const GENDER_LABELS = { F: 'Femmes', M: 'Hommes', U: 'Non précisé' };

/** Lit total_value d'une métrique : { value, breakdown: { CLE: valeur } | null }. */
export function readTotal(entry) {
  if (!entry) return null;
  const tv = entry.total_value;
  let value;
  if (tv && tv.value !== undefined) value = num(tv.value);
  else if (Array.isArray(entry.values) && entry.values.length) value = entry.values.reduce((s, v) => s + num(v.value), 0);
  let breakdown = null;
  const results = tv && Array.isArray(tv.breakdowns) && tv.breakdowns[0] && tv.breakdowns[0].results;
  if (Array.isArray(results)) {
    breakdown = {};
    results.forEach((r) => {
      const k = Array.isArray(r.dimension_values) ? r.dimension_values.join(' · ') : String(r.dimension_values ?? '');
      breakdown[k] = (breakdown[k] || 0) + num(r.value);
    });
    if (value === undefined) value = Object.values(breakdown).reduce((s, v) => s + v, 0);
  }
  return value === undefined && !breakdown ? null : { value: value ?? 0, breakdown };
}

/** Découpe [since, until] en tranches de 30 j max (secondes). */
export function chunkRange(since, until, max = MAX_RANGE_S) {
  const out = [];
  for (let s = since; s < until; s += max) out.push([s, Math.min(until, s + max)]);
  return out;
}

const sumBreakdowns = (a, b) => {
  if (!a) return b ? { ...b } : null;
  if (!b) return a;
  const out = { ...a };
  Object.entries(b).forEach(([k, v]) => { out[k] = (out[k] || 0) + v; });
  return out;
};

/** Champs d'une publication issus des insights par média (palier LOURD) : conservés tant que le palier lourd ne les remplace pas. */
export const HEAVY_POST_KEYS = ['views', 'shares', 'saves', 'reach', 'viewsCount', 'reposts', 'totalInteractions', 'profileVisits', 'follows', 'avgWatchTimeSeconds', 'totalWatchTimeSeconds', 'skipRate'];

/**
 * Publication normalisée. `ins` = insights du média (palier lourd) ; `light` = pas d'insights : les champs qui n'en
 * dépendent que sont null (le fusionneur de paliers conserve alors la valeur du dernier palier lourd).
 */
function buildPost(m, ins, { light = false } = {}) {
  const i = ins || {};
  const pt = PRODUCT_TYPES.has(m.media_product_type) ? m.media_product_type : null;
  const thumb = m.thumbnail_url || (m.media_type !== 'VIDEO' && m.media_url ? m.media_url : null);
  const avgMs = nn(i.ig_reels_avg_watch_time);
  const totMs = nn(i.ig_reels_video_view_total_time);
  return {
    id: `ig-${m.id}`,
    platform: 'instagram',
    type: TYPE(m),
    title: titleFrom(m.caption, TYPE(m)),
    publishedAt: toIso(m.timestamp),
    views: light ? null : num(i.reach ?? i.views), // contrat existant : libellé "Portée" côté front (repli sur les vues)
    likes: num(m.like_count),
    comments: num(m.comments_count),
    shares: light ? (m.shares_count === undefined ? null : num(m.shares_count)) : num(i.shares ?? m.shares_count),
    saves: nn(i.saved ?? m.saved_count),
    url: m.permalink || null,
    // Champs enrichis (null si inconnu) : `views` ci-dessus reste la portée héritée, les vraies vues sont dans viewsCount
    thumbnailUrl: thumb,
    imageUrlsExpire: Boolean(thumb),
    productType: pt,
    reach: nn(i.reach),
    viewsCount: nn(i.views ?? m.total_views_count),
    reposts: nn(i.reposts ?? m.reposts_count),
    totalInteractions: nn(i.total_interactions),
    profileVisits: nn(i.profile_visits),
    follows: nn(i.follows),
    avgWatchTimeSeconds: avgMs === null ? null : avgMs / MS_PER_SECOND,
    totalWatchTimeSeconds: totMs === null ? null : totMs / MS_PER_SECOND,
    skipRate: nn(i.reels_skip_rate)
  };
}

export function createInstagramProvider(cfg, { fetch = globalThis.fetch, now = () => Date.now() } = {}) {
  const c = cfg.instagram;
  const P = 'instagram';
  const g = (pathAndQuery, token) => {
    const sep = pathAndQuery.includes('?') ? '&' : '?';
    return fetchJson(fetch, P, `${GRAPH}/${c.graphVersion}/${pathAndQuery}${sep}access_token=${encodeURIComponent(token)}`);
  };

  async function toLongLived(shortToken) {
    const q = new URLSearchParams({ grant_type: 'ig_exchange_token', client_secret: c.appSecret, access_token: shortToken });
    const d = await fetchJson(fetch, P, `${GRAPH}/access_token?${q}`);
    if (!d.access_token) throw new ProviderError(P, 'auth', 'Échange du token long Instagram impossible.');
    return d;
  }

  return {
    id: P,
    label: 'Instagram',
    capabilities: { comments: true },

    authorizeUrl(state) {
      const q = new URLSearchParams({ client_id: c.appId, redirect_uri: c.redirectUri, response_type: 'code', scope: c.scopes, state });
      return `${AUTH_URL}?${q}`;
    },

    async exchangeCode(code) {
      // Instagram ajoute parfois "#_" à la fin du code
      const clean = String(code).replace(/#_$/, '');
      const d = await fetchJson(fetch, P, TOKEN_URL, {
        method: 'POST',
        form: { client_id: c.appId, client_secret: c.appSecret, grant_type: 'authorization_code', redirect_uri: c.redirectUri, code: clean }
      });
      const short = Array.isArray(d.data) ? d.data[0] : d; // anciennes réponses : { data: [ {...} ] }
      if (!short || !short.access_token) throw new ProviderError(P, 'auth', 'Échec OAuth Instagram.');
      const long = await toLongLived(short.access_token);
      return {
        accessToken: long.access_token,
        refreshToken: null, // Instagram rafraîchit le token long lui-même
        expiresAt: now() + num(long.expires_in || 60 * 86400) * 1000,
        obtainedAt: now(),
        scope: Array.isArray(short.permissions) ? short.permissions.join(',') : (short.permissions || c.scopes),
        userId: short.user_id ? String(short.user_id) : null
      };
    },

    /** Token long : 60 j. Rafraîchissable s'il a plus de 24 h ; on le fait à 7 j de l'échéance. */
    needsRefresh(token) {
      const age = now() - num(token.obtainedAt || 0);
      return token.expiresAt - now() < 7 * DAY && age > DAY && token.expiresAt > now();
    },

    async refresh(token) {
      const q = new URLSearchParams({ grant_type: 'ig_refresh_token', access_token: token.accessToken });
      const d = await fetchJson(fetch, P, `${GRAPH}/refresh_access_token?${q}`);
      if (!d.access_token) throw new ProviderError(P, 'auth', 'Rafraîchissement du token Instagram impossible.');
      return { ...token, accessToken: d.access_token, expiresAt: now() + num(d.expires_in || 60 * 86400) * 1000, obtainedAt: now() };
    },

    async revoke() { /* pas d'endpoint de révocation : retirer l'app depuis Instagram > Paramètres > Apps et sites web */ },

    /**
     * Insights du compte pour la période (7/30/90 j) et la période précédente, normalisés.
     * Chaque métrique est isolée : une métrique refusée par Meta est absente (null), les autres restent.
     * Seule une erreur d'authentification (token invalide) interrompt l'ensemble.
     */
    async fetchInsights(token, { period = 30 } = {}) {
      const t = token.accessToken;
      const errors = {};
      const noteErr = (key, err) => { errors[key] = err && err.message ? err.message : String(err); };

      /** Un appel /me/insights ; en cas d'échec d'un appel groupé, chaque métrique est retentée seule. */
      async function query(metrics, { breakdown, since, until }) {
        const out = {};
        const q = `me/insights?metric=${metrics.join(',')}&metric_type=total_value&period=day&since=${since}&until=${until}${breakdown ? `&breakdown=${breakdown}` : ''}`;
        try {
          const d = await g(q, t);
          const byName = new Map((d.data || []).map((e) => [e.name, e]));
          metrics.forEach((m) => { out[m] = readTotal(byName.get(m)); });
          return out;
        } catch (err) {
          if (err.code === 'auth') throw err;
          if (metrics.length === 1) { out[metrics[0]] = { error: err }; return out; }
        }
        for (const m of metrics) Object.assign(out, await query([m], { breakdown, since, until }));
        return out;
      }

      /** Métriques additives : somme sur des tranches de 30 j max (une tranche en échec invalide la métrique). */
      async function additive(metrics, { breakdown, since, until }) {
        const acc = Object.fromEntries(metrics.map((m) => [m, null]));
        for (const [s, u] of chunkRange(since, until)) {
          const todo = metrics.filter((m) => !(acc[m] && acc[m].error));
          if (!todo.length) break;
          const r = await query(todo, { breakdown, since: s, until: u });
          Object.entries(r).forEach(([m, v]) => {
            if (v && v.error) { acc[m] = v; return; }
            if (!v) return;
            acc[m] = acc[m] ? { value: acc[m].value + v.value, breakdown: sumBreakdowns(acc[m].breakdown, v.breakdown) } : v;
          });
        }
        return acc;
      }

      /** Comptes uniques : un seul appel sur toute la fenêtre (impossible d'additionner des tranches). */
      const uniques = (metrics, opts) => query(metrics, opts);

      // Seuil des 100 followers : protège follower_demographics, online_followers, follows_and_unfollows, follower_count
      let followersCount = null;
      try {
        const me = await g('me?fields=followers_count', t);
        followersCount = me.followers_count === undefined ? null : num(me.followers_count);
      } catch (err) {
        if (err.code === 'auth') throw err;
      }
      const belowThreshold = followersCount !== null && followersCount < DEMO_THRESHOLD;

      const until = Math.floor(now() / 1000);
      const span = period * 86400;
      const W = { cur: { since: until - span, until }, prev: { since: until - 2 * span, until: until - span } };

      const win = async (w) => {
        const [add, uniq, follows, viewsByFollower, buttons] = await Promise.all([
          additive(ADDITIVE, w),
          uniques(UNIQUES, w),
          belowThreshold ? Promise.resolve({ follows_and_unfollows: null }) : additive(['follows_and_unfollows'], { ...w, breakdown: 'follow_type' }),
          additive(['views'], { ...w, breakdown: 'follow_type' }),   // le breakdown valide est follow_type (FOLLOWER / NON_FOLLOWER), pas follower_type
          additive(['profile_links_taps'], { ...w, breakdown: 'contact_button_type' })
        ]);
        return {
          ...add, ...uniq,
          follows_and_unfollows: follows.follows_and_unfollows,
          views_by_follower: viewsByFollower.views,
          links_by_button: buttons.profile_links_taps
        };
      };
      const [cur, prev, extra] = await Promise.all([
        win(W.cur),
        win(W.prev),
        Promise.all([
          uniques(['reach'], { ...W.cur, breakdown: 'follow_type' }),
          additive(['views'], { ...W.cur, breakdown: 'media_product_type' })
        ])
      ]);
      cur.reach_by_follow = extra[0].reach;
      cur.views_by_type = extra[1].views;

      // Erreurs (période courante uniquement : la précédente sert seulement à la variation).
      // Si seul le découpage (breakdown) est refusé alors que le total est disponible : repli sans breakdown + note distincte.
      const BASE_OF = { views_by_follower: 'views', views_by_type: 'views', reach_by_follow: 'reach', links_by_button: 'profile_links_taps' };
      const breakdownRefused = [];
      for (const [k, v] of Object.entries(cur)) {
        if (!v || !v.error) continue;
        const base = BASE_OF[k];
        let totalOk = base ? cur[base] && !cur[base].error && cur[base] !== null : false;
        if (k === 'follows_and_unfollows') {
          // total sans découpage : si disponible, seul le breakdown est refusé
          const plain = await additive(['follows_and_unfollows'], W.cur);
          totalOk = Boolean(plain.follows_and_unfollows && !plain.follows_and_unfollows.error);
        }
        if (totalOk) { breakdownRefused.push(k); cur[k] = null; } else noteErr(k, v.error);
      }
      const ok = (v) => (v && !v.error ? v : null);
      const K = (key, pick = (v) => v.value) => {
        const c = ok(cur[key]);
        if (!c) return null;
        const p = ok(prev[key]);
        const pv = p ? pick(p) : null;
        return { value: pick(c), previous: Number.isFinite(pv) ? pv : null };
      };
      const part = (key, dim) => {
        const c = ok(cur[key]);
        if (!c || !c.breakdown) return null;
        return K(key, (v) => (v.breakdown ? num(v.breakdown[dim]) : null));
      };
      const list = (key, labels) => {
        const c = ok(cur[key]);
        if (!c || !c.breakdown) return null;
        return Object.entries(c.breakdown)
          .map(([k, v]) => ({ key: k, label: labels[k] || k, value: v }))
          .filter((x) => x.value > 0)
          .sort((a, b) => b.value - a.value);
      };

      const follows = belowThreshold ? null : part('follows_and_unfollows', 'FOLLOWER');
      const unfollows = part('follows_and_unfollows', 'NON_FOLLOWER');
      const net = follows && unfollows ? {
        value: follows.value - unfollows.value,
        previous: follows.previous !== null && unfollows.previous !== null ? follows.previous - unfollows.previous : null
      } : null;

      const out = {
        generatedAt: new Date(now()).toISOString(),
        views: {
          total: K('views'),
          followers: part('views_by_follower', 'FOLLOWER'),
          nonFollowers: part('views_by_follower', 'NON_FOLLOWER'),
          byContentType: list('views_by_type', CONTENT_LABELS),
          viewers: K('reach'),
          viewersFollowers: part('reach_by_follow', 'FOLLOWER'),
          viewersNonFollowers: part('reach_by_follow', 'NON_FOLLOWER')
        },
        interactions: {
          total: K('total_interactions'),
          engagedAccounts: K('accounts_engaged'),
          likes: K('likes'),
          saves: K('saves'),
          comments: K('comments'),
          shares: K('shares'),
          reposts: K('reposts'),
          replies: K('replies')
        },
        profile: {
          linkTaps: K('profile_links_taps'),
          addressTaps: part('links_by_button', 'DIRECTION'),
          byButton: list('links_by_button', BUTTON_LABELS),
          follows,
          unfollows,
          netFollowers: net
        },
        audience: await this.fetchAudience(token, { period, followersCount }),
        errors
      };
      const failed = Object.keys(errors);
      out.notes = failed.length ? [`Métriques refusées par Meta sur cette période (omises) : ${failed.join(', ')}.`] : [];
      if (breakdownRefused.length) out.notes.push(`Découpage refusé par Meta (total conservé, détail omis) : ${breakdownRefused.join(', ')}.`);
      if (belowThreshold) out.notes.push(`Gains et pertes d'abonnés indisponibles : Instagram les réserve aux comptes de ${DEMO_THRESHOLD} abonnés ou plus.`);
      if (period > 30 && !out.views.viewers) out.notes.push('Comptes uniques (spectateurs, comptes ayant interagi) : Meta ne les calcule pas sur 90 jours ; affichez 7 ou 30 jours.');
      return out;
    },

    /** Audience : démographie des followers et de l'audience engagée, heures d'activité des followers. */
    async fetchAudience(token, { period = 30, followersCount } = {}) {
      const t = token.accessToken;
      let followers = followersCount === undefined ? null : followersCount;
      if (followersCount === undefined) {
        try {
          const me = await g('me?fields=followers_count', t);
          followers = me.followers_count === undefined ? null : num(me.followers_count);
        } catch (err) {
          if (err.code === 'auth') throw err;
        }
      }
      if (followers !== null && followers < DEMO_THRESHOLD) {
        return { status: 'below_threshold', threshold: DEMO_THRESHOLD, followersCount: followers, followers: null, engaged: null, onlineHours: null };
      }

      async function demographics(metric, timeframes) {
        const res = {};
        let okCount = 0;
        for (const bd of DEMO_BREAKDOWNS) {
          for (const tf of timeframes) {
            try {
              const d = await g(`me/insights?metric=${metric}&period=lifetime&metric_type=total_value&timeframe=${tf}&breakdown=${bd}`, t);
              const r = readTotal((d.data || []).find((e) => e.name === metric));
              res[bd] = Object.entries((r && r.breakdown) || {})
                .map(([k, v]) => ({ key: k, label: bd === 'gender' ? (GENDER_LABELS[k] || k) : k, value: v }))
                .sort((a, b) => (bd === 'age' ? a.key.localeCompare(b.key) : b.value - a.value));
              res.timeframe = tf;
              okCount++;
              break;
            } catch (err) {
              if (err.code === 'auth') throw err;
            }
          }
        }
        return okCount ? res : null;
      }

      const fol = await demographics('follower_demographics', ['this_month', 'last_30_days']);
      const eng = await demographics('engaged_audience_demographics', [ENGAGED_TIMEFRAME[period] || 'last_30_days', 'this_month']);

      // online_followers : valeurs par heure (0–23) pour chaque jour des 30 derniers jours → moyenne par heure
      let onlineHours = null;
      try {
        const u = Math.floor(now() / 1000);
        const d = await g(`me/insights?metric=online_followers&period=lifetime&since=${u - 30 * 86400}&until=${u}`, t);
        const days = ((d.data && d.data[0] && d.data[0].values) || []).map((v) => v.value).filter((v) => v && typeof v === 'object' && Object.keys(v).length);
        if (days.length) {
          onlineHours = Array.from({ length: 24 }, (_, h) => Math.round(days.reduce((s, v) => s + num(v[h] ?? v[String(h)]), 0) / days.length));
        }
      } catch (err) {
        if (err.code === 'auth') throw err;
      }

      return {
        status: fol || eng || onlineHours ? 'ok' : 'unavailable',
        threshold: DEMO_THRESHOLD,
        followersCount: followers,
        followers: fol,
        engaged: eng,
        onlineHours
      };
    },

    /** Champs du palier lourd : conservés par la fusion tant que le palier lourd ne les remplace pas. */
    heavyPostKeys: HEAVY_POST_KEYS,

    /**
     * Palier LÉGER (toutes les ~60 s en direct) : profil + compteurs, première page des médias récents, portée
     * quotidienne récente et totaux des dernières 24 h. 4 appels en parallèle ; aucun insight par média,
     * aucune audience, aucun commentaire (palier lourd). Résultat partiel : fusionné par DataService.
     */
    async fetchLight(token) {
      const t = token.accessToken;
      const tolerant = async (q) => { try { return await g(q, t); } catch (err) { if (err.code === 'auth') throw err; return null; } };
      const until = Math.floor(now() / 1000);
      const TODAY = ['views', 'total_interactions', 'likes', 'comments', 'shares', 'saves', 'reposts', 'profile_links_taps'];
      const mediaPage = async () => {
        const tiers = [[MEDIA_BASE, MEDIA_VISUAL, MEDIA_COUNTS], [MEDIA_BASE, MEDIA_VISUAL], [MEDIA_BASE, MEDIA_COUNTS], [MEDIA_BASE]];
        let lastErr = null;
        for (const fields of tiers) {
          try { return await fetchJson(fetch, P, `${GRAPH}/${c.graphVersion}/me/media?fields=${fields.join(',')}&limit=50&access_token=${encodeURIComponent(t)}`); } catch (err) {
            if (err.code === 'auth') throw err;
            lastErr = err;
          }
        }
        throw lastErr;
      };
      const [me, page, reach, today] = await Promise.all([
        g('me?fields=user_id,username,name,account_type,followers_count,media_count', t),
        mediaPage(),
        tolerant(`me/insights?metric=reach&period=day&since=${until - 3 * 86400}&until=${until}`),
        tolerant(`me/insights?metric=${TODAY.join(',')}&metric_type=total_value&period=day&since=${until - 86400}&until=${until}`)
      ]);
      const cutoff = now() - HISTORY_DAYS * DAY;
      const recent = (page.data || []).filter((m) => new Date(toIso(m.timestamp)).getTime() >= cutoff);
      const dailyViews = {};
      ((reach && reach.data && reach.data[0] && reach.data[0].values) || []).forEach((v) => {
        dailyViews[isoDay(new Date(new Date(toIso(v.end_time)).getTime() - DAY))] = num(v.value);
      });
      let liveToday = null;
      if (today && Array.isArray(today.data)) {
        const byName = new Map(today.data.map((e) => [e.name, e]));
        liveToday = { windowHours: 24, asOf: new Date(now()).toISOString() };
        for (const m of TODAY) { const r = readTotal(byName.get(m)); liveToday[m] = r ? r.value : null; }
      }
      const username = me.username || '';
      return {
        partial: true,
        account: {
          platform: P,
          name: me.name || username || 'Compte Instagram',
          handle: username ? `@${username}` : '',
          url: username ? `https://www.instagram.com/${username}` : 'https://www.instagram.com/'
        },
        followers: me.followers_count === undefined ? null : num(me.followers_count),
        posts: recent.map((m) => buildPost(m, null, { light: true })),
        dailyViews,
        details: {
          profile: { username: username || null, name: me.name || null, accountType: me.account_type || null, followersCount: nn(me.followers_count), mediaCount: nn(me.media_count) },
          today: liveToday
        }
      };
    },

    /** Followers seuls (1 appel) : instantané quotidien en période d'inactivité. */
    async fetchFollowers(token) {
      const me = await g('me?fields=followers_count', token.accessToken);
      return me.followers_count === undefined ? null : num(me.followers_count);
    },

    async fetchData(token) {
      const t = token.accessToken;
      const notes = [];
      const insightCap = Math.max(1, num(c.insightMediaMax ?? INSIGHT_MEDIA));
      const commentCap = Math.max(0, num(c.commentMediaMax ?? COMMENT_MEDIA));
      const insightConcurrency = Math.max(1, num(c.insightConcurrency ?? INSIGHT_CONCURRENCY));
      /** Appel tolérant : renvoie les données, ou null si Meta refuse (l'erreur d'auth est propagée). */
      const tolerant = async (pathAndQuery) => {
        try { return await g(pathAndQuery, t); } catch (err) {
          if (err.code === 'auth') throw err;
          return null;
        }
      };

      // --- Profil + champs optionnels en parallèle (appels séparés : un refus ne casse pas l'appel principal)
      const [me, extraA, extraB] = await Promise.all([
        g('me?fields=user_id,username,name,account_type,followers_count,media_count', t),
        tolerant('me?fields=profile_picture_url,follows_count'),
        tolerant('me?fields=biography,website')
      ]);
      if (!extraA) notes.push('Photo de profil et nombre d’abonnements non fournis par Meta (champs omis).');
      if (!extraB) notes.push('Biographie et site web non fournis par Meta (champs omis).');

      // --- Médias (pagination jusqu'à couvrir l'historique utile), champs enrichis avec repli progressif
      const cutoff = now() - HISTORY_DAYS * DAY;
      const media = [];
      const tiers = [
        { fields: [MEDIA_BASE, MEDIA_VISUAL, MEDIA_COUNTS], lost: null },
        { fields: [MEDIA_BASE, MEDIA_VISUAL], lost: 'Compteurs de médias (reposts_count, saved_count, total_views_count…) refusés par Meta : omis.' },
        { fields: [MEDIA_BASE, MEDIA_COUNTS], lost: 'Champs d’image (media_url, thumbnail_url, shortcode…) refusés par Meta : omis.' },
        { fields: [MEDIA_BASE], lost: 'Champs d’image et compteurs de médias refusés par Meta : omis.' }
      ];
      let url = null;
      let firstPage = null;
      let lastErr = null;
      for (const tier of tiers) {
        const first = `${GRAPH}/${c.graphVersion}/me/media?fields=${tier.fields.join(',')}&limit=50&access_token=${encodeURIComponent(t)}`;
        try {
          firstPage = await fetchJson(fetch, P, first);
          if (tier.lost) notes.push(tier.lost);
          break;
        } catch (err) {
          if (err.code === 'auth') throw err;
          lastErr = err;
        }
      }
      if (!firstPage) throw lastErr;
      let pagesTruncated = false;
      let d = firstPage;
      for (let page = 0; page < MAX_MEDIA_PAGES; page++) {
        const list = d.data || [];
        media.push(...list);
        const oldest = list.length ? Math.min(...list.map((m) => new Date(toIso(m.timestamp)).getTime())) : 0;
        url = d.paging && d.paging.next && oldest >= cutoff && isGraphPagingUrl(d.paging.next) ? d.paging.next : null;
        if (!url) break;
        if (page === MAX_MEDIA_PAGES - 1) { pagesTruncated = true; break; }
        d = await fetchJson(fetch, P, url);
      }
      const recent = media.filter((m) => new Date(toIso(m.timestamp)).getTime() >= cutoff);

      // --- Insights par média (métriques variables selon le type ; repli progressif, métriques refusées signalées)
      const runInsights = async () => {
      let insightErrors = 0;
      const refused = new Set();
      let refusedMedia = 0;
      const insightTargets = recent.slice(0, insightCap);
      const res = await mapLimit(insightTargets, insightConcurrency, async (m) => {
        const full = m.media_product_type === 'REELS' ? REELS_METRICS : FEED_METRICS;
        const tiersM = METRIC_TIERS(full);
        for (let k = 0; k < tiersM.length; k++) {
          try {
            const r = await g(`${m.id}/insights?metric=${tiersM[k].join(',')}`, t);
            const got = Object.fromEntries((r.data || []).map((e) => [e.name, insightValue(e)]));
            if (k > 0) { full.filter((x) => !(x in got)).forEach((x) => refused.add(x)); refusedMedia++; }
            return got;
          } catch (err) {
            if (err.code === 'auth') throw err;
          }
        }
        insightErrors++;
        return null;
      });
      if (insightErrors) notes.push(`Insights indisponibles pour ${insightErrors} publication(s) (permission instagram_business_manage_insights ou type de média non supporté).`);
      if (refused.size) notes.push(`Métriques de publication refusées par Meta (omises) : ${[...refused].join(', ')} (sur ${refusedMedia} publication(s)).`);
      return res;
      };

      // (insights, quotidien et commentaires sont lus en parallèle plus bas)
      // --- Insights du compte : portée quotidienne (fenêtres de 30 j max, lues en parallèle) et gain de followers (30 derniers jours)
      const dailyViews = {};
      const dailyNewFollowers = {};
      const dayOf = (endTime) => isoDay(new Date(new Date(toIso(endTime)).getTime() - DAY));
      const followersNow = me.followers_count === undefined ? null : num(me.followers_count);
      const runDaily = async () => {
        const reachWindows = async () => {
          const until = Math.floor(now() / 1000);
          const results = await Promise.allSettled(Array.from({ length: 6 }, (_, k) => {
            const u = until - k * 30 * 86400;
            return g(`me/insights?metric=reach&period=day&since=${u - 30 * 86400}&until=${u}`, t);
          }));
          let failed = null;
          for (const r of results) {
            if (r.status === 'rejected') { failed ||= r.reason; continue; }
            ((r.value.data && r.value.data[0] && r.value.data[0].values) || []).forEach((v) => { dailyViews[dayOf(v.end_time)] = num(v.value); });
          }
          if (failed) throw failed;
        };
        const followerGain = async () => {
          if (followersNow !== null && followersNow < DEMO_THRESHOLD) {
            notes.push(`Gain quotidien de followers indisponible (Instagram le réserve aux comptes de ${DEMO_THRESHOLD}+ followers).`);
            return;
          }
          try {
            const u = Math.floor(now() / 1000);
            const dd = await g(`me/insights?metric=follower_count&period=day&since=${u - 30 * 86400}&until=${u}`, t);
            ((dd.data && dd.data[0] && dd.data[0].values) || []).forEach((v) => { dailyNewFollowers[dayOf(v.end_time)] = num(v.value); });
          } catch (err) {
            if (err.code === 'auth') throw err;
            notes.push(`Gain quotidien de followers indisponible (Instagram le réserve aux comptes de ${DEMO_THRESHOLD}+ followers).`);
          }
        };
        await Promise.all([
          reachWindows().catch((err) => {
            if (err.code === 'auth') throw err;
            notes.push('Portée quotidienne du compte indisponible : les vues sont estimées à partir des publications.');
          }),
          followerGain()
        ]);
      };

      // --- Commentaires des publications récentes les plus commentées
      const eligible = recent
        .filter((m) => num(m.comments_count) > 0 && new Date(toIso(m.timestamp)).getTime() >= now() - 90 * DAY);
      const withComments = eligible.slice(0, commentCap);
      let commentErrors = 0;
      const runComments = () => mapLimit(withComments, COMMENT_CONCURRENCY, async (m) => {
        try {
          const r = await g(`${m.id}/comments?fields=id,text,timestamp,username,like_count&limit=50`, t);
          return (r.data || []).map((x) => ({
            id: `ig-c-${x.id}`,
            platform: P,
            postId: `ig-${m.id}`,
            author: x.username || 'Utilisateur Instagram',
            handle: x.username ? `@${x.username}` : '',
            text: x.text || '',
            sentiment: sentiment(x.text),
            likes: num(x.like_count),
            createdAt: toIso(x.timestamp) || toIso(m.timestamp)
          }));
        } catch (err) {
          if (err.code === 'auth') throw err;
          commentErrors++;
          return [];
        }
      });

      // --- Les trois lectures indépendantes s'exécutent en parallèle
      const [insights, , lists] = await Promise.all([runInsights(), runDaily(), runComments()]);
      if (commentErrors) notes.push(`Commentaires illisibles sur ${commentErrors} publication(s) (permission instagram_business_manage_comments ?).`);
      const insightsFetchedFor = insights.filter(Boolean).length;
      const posts = recent.map((m, i) => buildPost(m, insights[i]));

      const coverage = {
        mediaFetched: recent.length,
        insightsFetchedFor,
        commentsFetchedFor: withComments.length - commentErrors,
        truncated: pagesTruncated || recent.length > insightCap || eligible.length > commentCap,
        windowDays: HISTORY_DAYS
      };
      if (coverage.truncated) notes.push(`Couverture partielle : insights lus pour ${insightsFetchedFor} publication(s) sur ${recent.length}, commentaires pour ${coverage.commentsFetchedFor} sur ${eligible.length}.`);

      // --- Reels : moyennes pondérées par les vues, uniquement sur les Reels mesurés
      const measured = posts.filter((p) => p.productType === 'REELS' && (p.avgWatchTimeSeconds !== null || p.skipRate !== null || p.totalWatchTimeSeconds !== null));
      const wavg = (key) => {
        const rows = measured.filter((p) => p[key] !== null);
        if (!rows.length) return null;
        const weights = rows.map((p) => (p.viewsCount > 0 ? p.viewsCount : 0));
        const wsum = weights.reduce((a, b) => a + b, 0);
        if (!wsum) return rows.reduce((a, p) => a + p[key], 0) / rows.length;
        return rows.reduce((a, p, k) => a + p[key] * weights[k], 0) / wsum;
      };
      const totals = measured.filter((p) => p.totalWatchTimeSeconds !== null);
      const reels = {
        count: measured.length,
        avgWatchTimeSeconds: wavg('avgWatchTimeSeconds'),
        totalWatchTimeSeconds: totals.length ? totals.reduce((a, p) => a + p.totalWatchTimeSeconds, 0) : null,
        skipRate: wavg('skipRate')
      };

      const username = me.username || '';
      const details = {
        profile: {
          username: username || null,
          name: me.name || null,
          accountType: me.account_type || null,
          biography: (extraB && extraB.biography) || null,
          website: (extraB && extraB.website) || null,
          profilePictureUrl: (extraA && extraA.profile_picture_url) || null,
          followersCount: nn(me.followers_count),
          followsCount: nn(extraA && extraA.follows_count),
          mediaCount: nn(me.media_count),
          imageUrlsExpire: true
        },
        reels,
        coverage,
        imageUrlsExpire: true,
        notes: [...notes]
      };
      return {
        account: {
          platform: P,
          name: me.name || username || 'Compte Instagram',
          handle: username ? `@${username}` : '',
          url: username ? `https://www.instagram.com/${username}` : 'https://www.instagram.com/'
        },
        followers: me.followers_count === undefined ? null : num(me.followers_count),
        posts,
        comments: lists.flat(),
        dailyViews,
        dailyNewFollowers,
        notes,
        details
      };
    }
  };
}
