// Connecteur TikTok : Login Kit (OAuth v2) + Display API.
// Doc : https://developers.tiktok.com/doc/login-kit-web/ et https://developers.tiktok.com/doc/display-api-overview/
// Limite : la Display API n'expose PAS les commentaires (texte) — seulement leur nombre par vidéo.
import { fetchJson, ProviderError } from '../http.js';
import { titleFrom, num } from '../util.js';

const AUTH_URL = 'https://www.tiktok.com/v2/auth/authorize/';
const API = 'https://open.tiktokapis.com/v2';
// Champs /user/info/ par scope : basic (open_id, avatar_url, display_name), profile (bio_description,
// profile_deep_link, is_verified, username), stats (follower_count, following_count, likes_count, video_count).
// Paliers de repli si TikTok refuse un champ (scope non accordé) : complet -> sans stats -> basique.
const USER_BASIC = 'open_id,avatar_url,display_name';
const USER_PROFILE = 'username,profile_deep_link,bio_description,is_verified';
const USER_STATS = 'follower_count,following_count,likes_count,video_count';
const USER_TIERS = [`${USER_BASIC},${USER_PROFILE},${USER_STATS}`, `${USER_BASIC},${USER_PROFILE}`, USER_BASIC];
// Liste des champs vidéo : la liste complète pour video/list est INCERTAINE -> appel étendu puis repli sur l'ancien jeu.
const VIDEO_FIELDS_LEGACY = 'id,title,video_description,create_time,share_url,duration,like_count,comment_count,share_count,view_count';
const VIDEO_FIELDS_EXT = `${VIDEO_FIELDS_LEGACY},cover_image_url,height,width`;
const HISTORY_DAYS = 190;
const MAX_PAGES = 10; // 10 × 20 vidéos
const DAY_MS = 86_400_000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** Inconnu -> null (jamais 0). */
const nv = (v) => (v === undefined || v === null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
const sv = (v) => (typeof v === 'string' && v.trim() ? v : null);

/** Tranche de durée (bornes : 15 -> '≤15 s', 30 -> '15–30 s', 60 -> '30–60 s'). */
export function durationBucket(sec) {
  if (sec === null || sec === undefined) return null;
  if (sec <= 15) return '≤15 s';
  if (sec <= 30) return '15–30 s';
  if (sec <= 60) return '30–60 s';
  return '> 60 s';
}

/**
 * Taux d'engagement = (likes + commentaires + partages) / vues, en fraction (0.05 = 5 %).
 * null si les vues sont inconnues ou nulles. Les sauvegardes ne sont pas incluses (non fournies par TikTok).
 */
export function engagementRate(views, likes, comments, shares) {
  if (!views || views <= 0) return null;
  return (num(likes) + num(comments) + num(shares)) / views;
}

export function createTikTokProvider(cfg, { fetch = globalThis.fetch, now = () => Date.now() } = {}) {
  const c = cfg.tiktok;
  const P = 'tiktok';
  const RATE_MSG = 'Limite de requêtes TikTok atteinte (trop d\'appels). Réessayez dans quelques minutes.';
  const retryDelayMs = c.retryDelayMs ?? 500;

  /** Retry court sur 429 / rate_limit_exceeded : 2 essais max, délai doublé plafonné à 5 s, puis erreur rate_limit. */
  async function withRetry(fn) {
    for (let attempt = 0; ; attempt++) {
      try {
        return await fn();
      } catch (err) {
        const limited = err instanceof ProviderError && err.code === 'rate_limit';
        if (!limited) throw err;
        if (attempt >= 2) throw new ProviderError(P, 'rate_limit', RATE_MSG, 429);
        await sleep(Math.min(retryDelayMs * 2 ** attempt, 5000));
      }
    }
  }
  const call = (url, opts) => withRetry(async () => checkApi(await fetchJson(fetch, P, url, opts)));
  /** Erreur de champ/scope refusé : on peut retenter avec moins de champs (pas pour auth / quota / réseau). */
  const degradable = (err) => err instanceof ProviderError && (err.code === 'permission' || err.code === 'upstream');

  /** L'endpoint token de TikTok peut renvoyer 200 avec {error, error_description}. */
  function checkTokenResponse(d) {
    if (d.error || !d.access_token) {
      throw new ProviderError(P, 'auth', `Échec OAuth TikTok${d.error ? ` (${d.error})` : ''}.`);
    }
    return {
      accessToken: d.access_token,
      refreshToken: d.refresh_token || null,
      refreshExpiresIn: d.refresh_expires_in ? num(d.refresh_expires_in) : null,
      expiresAt: now() + num(d.expires_in || 86400) * 1000,
      refreshExpiresAt: d.refresh_expires_in ? now() + num(d.refresh_expires_in) * 1000 : null,
      scope: d.scope || c.scopes,
      userId: d.open_id || null
    };
  }

  /** Les réponses Display API ont la forme { data, error: { code: 'ok' | ... } }. */
  function checkApi(d) {
    const code = d && d.error && d.error.code;
    if (code && code !== 'ok') {
      if (code === 'rate_limit_exceeded') throw new ProviderError(P, 'rate_limit', RATE_MSG, 429);
      const kind = code === 'access_token_invalid' ? 'auth' : code === 'rate_limit_exceeded' ? 'rate_limit' : code === 'scope_not_authorized' ? 'permission' : 'upstream';
      throw new ProviderError(P, kind, `Erreur API TikTok (${code}).`);
    }
    return d.data || {};
  }

  return {
    id: P,
    label: 'TikTok',
    capabilities: { comments: false },

    authorizeUrl(state) {
      const q = new URLSearchParams({ client_key: c.clientKey, scope: c.scopes, response_type: 'code', redirect_uri: c.redirectUri, state });
      return `${AUTH_URL}?${q}`;
    },

    async exchangeCode(code) {
      const d = await fetchJson(fetch, P, `${API}/oauth/token/`, {
        method: 'POST',
        form: { client_key: c.clientKey, client_secret: c.clientSecret, code, grant_type: 'authorization_code', redirect_uri: c.redirectUri }
      });
      return checkTokenResponse(d);
    },

    /** Access token : 24 h ; refresh token : 365 j. On rafraîchit dès qu'il reste moins d'1 h. */
    needsRefresh(token) {
      return Boolean(token.refreshToken) && token.expiresAt - now() < 60 * 60_000;
    },

    async refresh(token) {
      if (!token.refreshToken) return null;
      const d = await withRetry(() => fetchJson(fetch, P, `${API}/oauth/token/`, {
        method: 'POST',
        form: { client_key: c.clientKey, client_secret: c.clientSecret, grant_type: 'refresh_token', refresh_token: token.refreshToken }
      }));
      const t = checkTokenResponse(d);
      // TikTok peut changer le refresh_token à chaque refresh : on renvoie le dernier (ancien conservé s'il n'est pas renvoyé).
      return {
        ...t,
        refreshToken: t.refreshToken || token.refreshToken,
        refreshExpiresAt: t.refreshExpiresAt ?? token.refreshExpiresAt ?? null,
        userId: token.userId
      };
    },

    async revoke(token) {
      await fetchJson(fetch, P, `${API}/oauth/revoke/`, {
        method: 'POST',
        form: { client_key: c.clientKey, client_secret: c.clientSecret, token: token.accessToken }
      });
    },

    /** Champs d'une vidéo conservés par la fusion quand le palier léger n'en a pas (miniature signée récupérée par le palier lourd). */
    heavyPostKeys: ['coverUrl'],

    /** Palier LÉGER : profil + première page de vidéos (compteurs récents), 2 appels en parallèle. Résultat partiel. */
    fetchLight(token) { return this.fetchData(token, { light: true }); },

    /** Followers seuls (1 appel) : instantané quotidien en période d'inactivité. */
    async fetchFollowers(token) {
      const d = await call(`${API}/user/info/?fields=${USER_BASIC},${USER_STATS}`, { headers: { Authorization: `Bearer ${token.accessToken}` } });
      return d.user && d.user.follower_count !== undefined ? num(d.user.follower_count) : null;
    },

    async fetchData(token, { light = false } = {}) {
      const auth = { Authorization: `Bearer ${token.accessToken}` };
      const notes = ['Commentaires non disponibles pour TikTok : la Display API ne fournit que leur nombre, pas leur contenu.'];

      // --- Profil (repli par paliers si un scope est refusé)
      const loadUser = async () => {
      let u = null;
      let tier = 0;
      for (; tier < USER_TIERS.length; tier++) {
        try {
          u = (await call(`${API}/user/info/?fields=${USER_TIERS[tier]}`, { headers: auth })).user || {};
          break;
        } catch (err) {
          if (!degradable(err) || tier === USER_TIERS.length - 1) throw err;
        }
      }
      return { u, tier };
      };

      const cutoff = now() - HISTORY_DAYS * DAY_MS;
      // --- Vidéos
      const loadVideos = async () => {
      const videos = [];
      let cursor;
      let fields = VIDEO_FIELDS_EXT;
      let hasMore = false;
      let oldest = Infinity;
      for (let page = 0; page < (light ? 1 : MAX_PAGES); page++) {
        const body = { max_count: 20, ...(cursor ? { cursor } : {}) };
        let d;
        try {
          d = await call(`${API}/video/list/?fields=${fields}`, { method: 'POST', headers: auth, json: body });
        } catch (err) {
          if (fields === VIDEO_FIELDS_EXT && degradable(err)) {
            fields = VIDEO_FIELDS_LEGACY; // champ étendu refusé : repli sur les champs historiques
            d = await call(`${API}/video/list/?fields=${fields}`, { method: 'POST', headers: auth, json: body });
          } else throw err;
        }
        const list = d.videos || [];
        videos.push(...list);
        hasMore = Boolean(d.has_more);
        oldest = list.length ? Math.min(...list.map((v) => num(v.create_time) * 1000)) : Infinity;
        if (!hasMore || !list.length || oldest < cutoff) break;
        cursor = d.cursor;
      }
      const truncated = !light && hasMore && !(oldest < cutoff);
      return { videos, truncated };
      };


      const [{ u, tier }, { videos, truncated }] = await Promise.all([loadUser(), loadVideos()]);
      if (tier >= 1) notes.push('Statistiques du compte indisponibles (scope user.info.stats non accordé) : followers, abonnements, mentions J\'aime et nombre de vidéos non affichés.');
      else if (u.follower_count === undefined) notes.push('Nombre de followers indisponible (scope user.info.stats non accordé).');
      if (tier >= 2) notes.push('Profil détaillé indisponible (scope user.info.profile non accordé) : pseudo, bio et badge vérifié non affichés.');
      else if (u.username === undefined) notes.push('Profil détaillé indisponible (scope user.info.profile non accordé).');
      if (truncated) notes.push(`Historique TikTok tronqué : seules les ${videos.length} vidéos les plus récentes (${MAX_PAGES} pages de 20) sont analysées.`);
      const inWindow = videos.filter((v) => num(v.create_time) * 1000 >= cutoff);

      // --- Miniatures : video/query seulement si cover_image_url manque (l'URL expire)
      const covers = new Map(inWindow.filter((v) => v.cover_image_url).map((v) => [String(v.id), v.cover_image_url]));
      const missing = light ? [] : inWindow.filter((v) => !v.cover_image_url).map((v) => String(v.id));
      for (let i = 0; i < missing.length; i += 20) {
        try {
          const q = await call(`${API}/video/query/?fields=id,cover_image_url`, { method: 'POST', headers: auth, json: { filters: { video_ids: missing.slice(i, i + 20) } } });
          for (const v of q.videos || []) if (v.cover_image_url) covers.set(String(v.id), v.cover_image_url);
        } catch (err) {
          if (err instanceof ProviderError && err.code === 'auth') throw err;
          notes.push('Miniatures TikTok indisponibles.');
          break;
        }
      }

      const posts = inWindow.map((v) => {
        const durationSeconds = nv(v.duration);
        const views = num(v.view_count), likes = num(v.like_count), comments = num(v.comment_count), shares = num(v.share_count);
        return {
          id: `tt-${v.id}`,
          platform: P,
          type: v.duration === undefined ? 'Vidéo' : num(v.duration) <= 60 ? 'Vidéo courte' : 'Vidéo longue',
          title: titleFrom(v.title || v.video_description, 'Vidéo sans titre'),
          publishedAt: new Date(num(v.create_time) * 1000).toISOString(),
          views,
          likes,
          comments,
          shares,
          saves: null, // non fourni par la Display API
          url: v.share_url || null,
          coverUrl: covers.get(String(v.id)) || null,
          durationSeconds,
          durationBucket: durationBucket(durationSeconds),
          engagementRate: v.view_count === undefined ? null : engagementRate(views, likes, comments, shares)
        };
      });

      // --- Cadence (moyenne sur la fenêtre réellement couverte)
      const times = posts.map((p) => Date.parse(p.publishedAt));
      let postsPerWeek = null;
      if (posts.length >= 2) {
        const start = truncated ? Math.min(...times) : cutoff;
        const spanDays = Math.max((now() - start) / DAY_MS, 1);
        postsPerWeek = Math.round((posts.length / (spanDays / 7)) * 100) / 100;
      }

      const username = u.username || '';
      const account = {
          platform: P,
          name: u.display_name || username || 'Compte TikTok',
          handle: username ? `@${username}` : (u.display_name || ''),
          url: u.profile_deep_link || (username ? `https://www.tiktok.com/@${username}` : 'https://www.tiktok.com/')
      };
      const profile = {
            username: sv(u.username),
            displayName: sv(u.display_name),
            bio: sv(u.bio_description),
            isVerified: typeof u.is_verified === 'boolean' ? u.is_verified : null,
            avatarUrl: sv(u.avatar_url),
            profileDeepLink: sv(u.profile_deep_link),
            followerCount: nv(u.follower_count),
            followingCount: nv(u.following_count),
            likesCount: nv(u.likes_count),
            videoCount: nv(u.video_count)
      };
      if (light) {
        // Palier léger : couverture, cadence et notes d'historique appartiennent au palier lourd (conservées par la fusion).
        return { partial: true, account, followers: u.follower_count === undefined ? null : num(u.follower_count), posts, comments: null, notes, details: { imageUrlsExpire: true, profile } };
      }
      return {
        account,
        followers: u.follower_count === undefined ? null : num(u.follower_count),
        posts,
        comments: null, // non disponible via Display API
        notes,
        details: {
          imageUrlsExpire: true, // avatarUrl et coverUrl expirent : ne pas les persister
          profile,
          coverage: { videosFetched: videos.length, windowDays: HISTORY_DAYS, maxPages: MAX_PAGES, truncated },
          cadence: { postsPerWeek, lastPostAt: times.length ? new Date(Math.max(...times)).toISOString() : null },
          notes
        }
      };
    }
  };
}
