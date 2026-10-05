/* Accès aux données réelles via le backend authentifié, sans repli local. */
(function () {
  'use strict';

  const PLATFORMS = ['tiktok', 'instagram', 'linkedin'];
  const PLATFORM_LABELS = { tiktok: 'TikTok', instagram: 'Instagram', linkedin: 'LinkedIn' };
  // Libellé de la métrique "vues" selon la plateforme
  const VIEW_LABELS = { tiktok: 'Vues', instagram: 'Portée', linkedin: 'Impressions' };
  const CONFIG = Object.assign({ mode: 'api', apiBase: '/api', healthTimeoutMs: 4000, loginPage: 'login.html' }, window.DASHBOARD_CONFIG || {});

  /** Erreur typée : code = 'unauthenticated' | 'not_connected' | 'token_expired' | 'provider_error' | 'network' | 'http' … */
  class ApiError extends Error {
    constructor(message, { status = 0, code = 'http', platform = null, data = null } = {}) {
      super(message);
      this.name = 'ApiError';
      Object.assign(this, { status, code, platform, data });
    }
  }

  const clampPeriod = (p) => ([7, 30, 90].includes(Number(p)) ? Number(p) : 30);
  const validPlatform = (p) => { if (!PLATFORMS.includes(p)) throw new Error('Plateforme inconnue'); return p; };

  // =====================================================================
  // Source distante (backend /api)
  // =====================================================================
  let redirecting = false;
  function redirectToLogin({ expired = false } = {}) {
    if (redirecting) return;
    redirecting = true;
    const params = new URLSearchParams();
    if (expired) params.set('expired', '1');
    if (/^#\/[a-z]+(\/[a-z]+)?$/.test(location.hash || '')) params.set('next', location.hash);
    const qs = params.toString();
    location.assign(`${CONFIG.loginPage}${qs ? `?${qs}` : ''}`);
  }

  /** Requête brute : { data, status, headers }. signal : annulation par l'appelant (code 'aborted') ; timeoutMs : délai propre à l'appel. */
  async function rawRequest(path, { method = 'GET', params, body, signal, timeoutMs = 25000 } = {}) {
    const qs = params ? new URLSearchParams(Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== '').sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))).toString() : '';
    let res;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    const onAbort = () => controller.abort();
    if (signal) { if (signal.aborted) controller.abort(); else signal.addEventListener('abort', onAbort, { once: true }); }
    try {
      res = await fetch(`${CONFIG.apiBase}${path}${qs ? `?${qs}` : ''}`, {
        method,
        signal: controller.signal,
        credentials: 'same-origin',
        cache: 'no-store',
        headers: body !== undefined ? { 'Content-Type': 'application/json', Accept: 'application/json' } : { Accept: 'application/json' },
        body: body !== undefined ? JSON.stringify(body) : undefined
      });
    } catch (e) {
      if (signal && signal.aborted) throw new ApiError('Requête annulée.', { code: 'aborted' });
      throw new ApiError('Serveur injoignable : vérifiez votre connexion réseau.', { code: 'network' });
    } finally { clearTimeout(timeout); if (signal) signal.removeEventListener('abort', onAbort); }
    let data = null;
    try { data = await res.json(); } catch (e) { /* réponse vide (204) ou non JSON */ }
    const headers = {};
    for (const h of ['X-Data-Updated-At', 'X-Data-Stale', 'X-Data-Refreshing', 'X-Data-Loading']) { const v = res.headers.get(h); if (v !== null) headers[h] = v; }
    if (res.status === 401) {
      redirectToLogin({ expired: true });
      throw new ApiError('Session expirée : reconnexion nécessaire.', { status: 401, code: 'unauthenticated' });
    }
    if (!res.ok) {
      const err = new ApiError((data && data.message) || `Erreur HTTP ${res.status}`, {
        status: res.status, code: (data && data.error) || 'http', platform: data && data.platform, data
      });
      err.retryAfter = res.headers.get('Retry-After');
      throw err;
    }
    return { data, status: res.status, headers };
  }
  const request = async (path, opts) => (await rawRequest(path, opts)).data;

  // =====================================================================
  // Cache client en MÉMOIRE (jamais localStorage / sessionStorage : données de comptes) — stale-while-revalidate.
  // Une réponse récente est rendue tout de suite ; au-delà de `freshMs` elle est rendue ET relue en arrière-plan ; au-delà de `maxAgeMs` elle est ignorée.
  // Chaque relecture (arrière-plan ou sondage du mode en direct) notifie les écouteurs { key, prev, next } : l'interface décide s'il y a du nouveau.
  // =====================================================================
  const invalidate = () => swr.clear();
  const SWR_FRESH_MS = 5000, SWR_MAX_AGE_MS = 10 * 60000;
  const swr = new Map();          // clé → { value: {data, headers, at}, promise, revalidating }
  const keyDefs = new Map();      // clé → { path, params } (conservé après invalidate : sert au sondage)
  const listeners = new Set();
  let tracking = null;
  const keyOf = (path, params) => `${path}?${params ? new URLSearchParams(Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== '').sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))).toString() : ''}`;
  const emit = (info) => listeners.forEach((fn) => { try { fn(info); } catch (e) { /* un écouteur ne casse jamais le chargement */ } });

  function store(key, r) {
    const prev = swr.get(key) && swr.get(key).value;
    const value = { data: r.data, headers: r.headers || {}, at: Date.now() };
    const entry = swr.get(key) || {};
    entry.value = value; entry.promise = null; entry.revalidating = false; entry.error = null;
    swr.set(key, entry);
    return { prev, next: value };
  }

  /** Lecture SWR d'une route GET de données. Les clés lues pendant un rendu sont mémorisées (trackStart / trackEnd). */
  function cached(path, params, { freshMs = SWR_FRESH_MS, maxAgeMs = SWR_MAX_AGE_MS, track = true, negativeMs = 0 } = {}) {
    const key = keyOf(path, params);
    keyDefs.set(key, { path, params });
    if (track && tracking) tracking.add(key);
    const e = swr.get(key), t = Date.now();
    // Cache NÉGATIF court (option negativeMs) : une erreur du serveur (hors session / réseau) est rejouée telle quelle au lieu de relancer la requête à chaque rendu.
    if (negativeMs && e && e.error && !(e.value && t - e.value.at <= maxAgeMs) && t - e.error.at < negativeMs) return Promise.reject(e.error.err);
    if (e && e.value && t - e.value.at <= maxAgeMs) {
      if (t - e.value.at > freshMs && !e.revalidating && !e.promise) background(key);
      return Promise.resolve(e.value.data);
    }
    if (e && e.promise) return e.promise.then((v) => v.data);
    const entry = e || {};
    entry.promise = rawRequest(path, { params }).then((r) => { store(key, r); return swr.get(key).value; }, (err) => {
      if (swr.get(key) === entry) { entry.promise = null; if (negativeMs && err && err.code !== 'unauthenticated' && err.code !== 'aborted' && err.code !== 'network') entry.error = { err, at: Date.now() }; }
      throw err;
    });
    swr.set(key, entry);
    return entry.promise.then((v) => v.data);
  }

  function background(key) {
    const e = swr.get(key), def = keyDefs.get(key);
    if (!e || !def) return;
    e.revalidating = true;
    rawRequest(def.path, { params: def.params }).then((r) => {
      const { prev, next } = store(key, r);
      emit({ key, path: def.path, prev, next, background: true });
    }, (err) => {
      e.revalidating = false;
      if (err && err.code === 'unauthenticated') return;
      if (err && err.code !== 'network' && err.code !== 'aborted') { swr.delete(key); emit({ key, path: def.path, prev: e.value, next: null, error: err, background: true }); }
    });
  }

  /** Relit des clés (sondage du mode en direct) en contournant le cache ; met le cache à jour et renvoie [{key, prev, next}]. Erreurs réseau : propagées (backoff côté appelant). */
  async function refetch(keys, { signal } = {}) {
    const out = [];
    await Promise.all([...keys].map(async (key) => {
      const def = keyDefs.get(key); if (!def) return;
      const before = swr.get(key) && swr.get(key).value;
      try {
        const r = await rawRequest(def.path, { params: def.params, signal, timeoutMs: 15000 });
        const { next } = store(key, r);
        out.push({ key, path: def.path, prev: before || null, next });
      } catch (err) {
        if (err && ['not_connected', 'token_expired', 'pending_approval', 'provider_error'].includes(err.code)) { swr.delete(key); out.push({ key, path: def.path, prev: before || null, next: null, error: err }); return; }
        throw err;
      }
    }));
    return out;
  }

  const remote = {
    getAccounts: () => request('/accounts'),
    getOverview: ({ period = 30 } = {}) => cached('/overview', { period: clampPeriod(period) }),
    getPlatformStats: (platform, { period = 30 } = {}) => cached(`/platforms/${encodeURIComponent(validPlatform(platform))}/stats`, { period: clampPeriod(period) }),
    getPosts: ({ platform, period = 30, sort = 'publishedAt', limit } = {}) =>
      cached('/posts', { platform: platform ? validPlatform(platform) : undefined, period: clampPeriod(period), sort, limit }),
    getComments: ({ platform = '', sentiment = '', q = '', period = 30, limit } = {}) =>
      cached('/comments', { platform, sentiment, q, period: clampPeriod(period), limit }),
    getInsights: (platform, { period = 30 } = {}) => cached(`/platforms/${encodeURIComponent(validPlatform(platform))}/insights`, { period: clampPeriod(period) }, { negativeMs: 30000 }),
    getStatus: () => cached('/status', undefined, { freshMs: 15000, track: false })
  };

  // =====================================================================
  // Choix de la source
  // =====================================================================
  const mode = async () => 'api';
  // Appel SYNCHRONE (la clé de cache est lue immédiatement : suivi des données d'une page) ; une erreur de validation devient un rejet.
  const call = (fn) => { try { return Promise.resolve(fn()); } catch (e) { return Promise.reject(e); } };

  // =====================================================================
  // API publique
  // =====================================================================
  const Api = {
    /** Snapshot Dokploy complet (SWR : rendu immédiat d'un snapshot de moins de 5 min, relu en fond au-delà de 15 s ; le serveur le met lui-même en cache 15 s). */
    getInfrastructure: () => cached('/infrastructure', undefined, { freshMs: 15000, maxAgeMs: 5 * 60000, track: false }),
    /** Snapshot relu SANS cache client (suite à un changement de statut détecté par /live). */
    async refreshInfrastructure({ signal } = {}) {
      const r = await rawRequest('/infrastructure', { signal, timeoutMs: 25000 });
      const key = keyOf('/infrastructure'); keyDefs.set(key, { path: '/infrastructure' }); store(key, r);
      return r.data;
    },
    /** Remplace la valeur en cache du snapshot (valeurs fusionnées par /live) sans changer son âge : un nouveau rendu repart des dernières valeurs connues. */
    putInfrastructure(value) {
      const e = swr.get(keyOf('/infrastructure'));
      if (e && e.value) e.value = { ...e.value, data: value };
    },
    /** Mode en direct : charge utile légère (≈ 1 Ko, no-store), limite dédiée de 90/min côté serveur. */
    getInfrastructureLive: ({ signal } = {}) => request('/infrastructure/live', { signal, timeoutMs: 8000 }),
    /** Mode en direct : battement de présence (POST /api/live/ping, corps `{}`, réponse 204). */
    livePing: ({ signal } = {}) => request('/live/ping', { method: 'POST', body: {}, signal, timeoutMs: 8000 }),
    /** Cache SWR : clés lues pendant un rendu (trackStart → trackEnd), relecture groupée, lecture sans effet de bord, écouteur de relectures. */
    trackStart() { tracking = new Set(); return tracking; },
    trackEnd(t) { if (tracking === t) tracking = null; return t ? [...t] : []; },
    refetch,
    peek: (key) => { const e = swr.get(key); return e && e.value ? e.value : null; },
    onData(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    /** Une redirection vers la connexion est en cours : plus aucune requête périodique. */
    isRedirecting: () => redirecting,
    /** Vide le cache des requêtes partagées (infrastructure, statut) : après redéploiement, « Réessayer », déconnexion d'un compte. */
    invalidate,
    /** Vérifie la session avant tout chargement de données. Redirige vers la connexion (sans ?expired) si absente. */
    async checkSession() {
      try {
        const res = await fetch(`${CONFIG.apiBase}/auth/session`, { credentials: 'same-origin', cache: 'no-store', headers: { Accept: 'application/json' } });
        const d = res.ok ? await res.json().catch(() => null) : null;
        if (d && d.authenticated) return true;
        if (res.ok || res.status === 401) { redirectToLogin(); return false; }
      } catch (e) { /* API injoignable : le chargement normal affichera l'erreur réseau */ }
      return true;
    },
    /**
     * Force la collecte d'une plateforme (POST /api/platforms/:p/refresh, corps JSON `{}` obligatoire).
     * Réponse : {ok, platform, status: 'refreshed'|'budget_exhausted', refreshed, updatedAt, budget, message}. Erreur 429 `refresh_too_soon` possible.
     */
    async refreshPlatform(platform) {
      const r = await request(`/platforms/${encodeURIComponent(validPlatform(platform))}/refresh`, { method: 'POST', body: {} });
      invalidate();
      return r;
    },
    /**
     * Renouvelle le jeton d'un réseau MAINTENANT (POST /api/platforms/:p/token/refresh, corps `{}`).
     * 200 → {ok, platform, renewed, expiresAt, refreshExpiresAt, renewedAt, message}. Erreurs typées (ApiError) : status 409 (code not_connected | pending_approval |
     * not_refreshable | reconnect_required | too_soon), 429 (refresh_too_soon | too_many_requests), 502 (upstream) ; champs ajoutés : reconnectPath, eligibleAt, retryAfter.
     * Le cache SWR (statut, vue d'ensemble) est invalidé dans tous les cas : la santé du jeton a pu changer.
     */
    async renewToken(platform) {
      try {
        const r = await request(`/platforms/${encodeURIComponent(validPlatform(platform))}/token/refresh`, { method: 'POST', body: {} });
        invalidate();
        return r;
      } catch (err) {
        if (err instanceof ApiError && err.code !== 'unauthenticated') {
          const d = err.data || {};
          err.reconnectPath = typeof d.reconnectPath === 'string' ? d.reconnectPath : null;
          err.eligibleAt = typeof d.eligibleAt === 'string' ? d.eligibleAt : null;
          if (err.retryAfter === null || err.retryAfter === undefined) err.retryAfter = d.retryAfter ?? null;
          invalidate();
        }
        throw err;
      }
    },
    getDeploymentLogs: (id) => request(`/deployments/${encodeURIComponent(id)}/logs`),
    redeploy: (type, id) => request(`/infrastructure/services/${encodeURIComponent(type)}/${encodeURIComponent(id)}/redeploy`, { method: 'POST', body: { confirmed: true } }),
    reloadApplication: (id) => request(`/infrastructure/services/application/${encodeURIComponent(id)}/reload`, { method: 'POST', body: { confirmed: true } }),
    getOperation: (id) => request(`/infrastructure/operations/${encodeURIComponent(id)}`),
    PLATFORMS,
    PLATFORM_LABELS,
    VIEW_LABELS,
    ApiError,

    /** Source backend exclusivement. */
    getMode: mode,

    /** Comptes suivis. */
    getAccounts() { return call(() => remote.getAccounts()); },

    /**
     * Vue d'ensemble.
     * @param {{period:number}} opts 7 | 30 | 90 jours
     */
    getOverview(opts) { return call(() => remote.getOverview(opts)); },

    /** Statistiques détaillées d'une plateforme. Lève ApiError code 'not_connected' si le compte n'est pas relié. */
    getPlatformStats(platform, opts) { return call(() => remote.getPlatformStats(platform, opts)); },

    /**
     * Publications.
     * @param {{platform?:string, period?:number, sort?:string, limit?:number}} opts
     */
    getPosts(opts) { return call(() => remote.getPosts(opts)); },

    /**
     * Commentaires agrégés des 3 plateformes.
     * En mode API, la réponse contient aussi `unavailable` : [{platform, reason}] (ex. TikTok).
     * @param {{platform?:string, sentiment?:string, q?:string, period?:number, limit?:number}} opts
     */
    getComments(opts) { return call(() => remote.getComments(opts)); },

    /**
     * Insights du compte (Instagram uniquement) : vues, interactions, profil, audience.
     * Seules les métriques réellement fournies par l'API Meta sont présentes (les autres sont absentes ou null).
     */
    getInsights(platform, opts) { return call(() => remote.getInsights(platform, opts)); },

    /** État des connexions (jamais de token). */
    getStatus() { return call(() => remote.getStatus()); },

    /** URL qui lance l'OAuth d'une plateforme (navigation pleine page). */
    connectUrl(platform) { return `${CONFIG.apiBase}/auth/${encodeURIComponent(validPlatform(platform))}/login`; },

    async disconnect(platform) {
      invalidate();
      return request(`/auth/${encodeURIComponent(validPlatform(platform))}/disconnect`, { method: 'POST', body: {} });
    },

    async logout() {
      try { await request('/auth/logout', { method: 'POST', body: {} }); } finally { location.assign(CONFIG.loginPage); }
    },

    /** Révoque TOUTES les sessions ouvertes (cookie copié ou volé compris). */
    async logoutAll() {
      try { await request('/auth/logout-all', { method: 'POST', body: {} }); } finally { location.assign(CONFIG.loginPage); }
    }
  };

  window.Api = Api;
})();
