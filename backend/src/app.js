// Application Fastify : routes /api/*, authentification par session, OAuth des plateformes.
import Fastify from 'fastify';
import { DokployClient, DokployError } from './dokploy.js';
import { DokployLive } from './dokploy-live.js';
import { Presence } from './presence.js';
import { PLATFORMS, LABELS } from './providers/index.js';
import { platformConfigured } from './config.js';
import { ProviderError } from './http.js';
import * as agg from './aggregate.js';
import { projectDetails, coverageOf } from './projection.js';
import {
  SESSION_COOKIE, OAUTH_COOKIE, parseCookies, serializeCookie, createSession, verifySession, LoginLimiter, OAuthStates
} from './security.js';
import { safeEqual } from './crypto.js';
import { linkedinPendingSteps, RenewError } from './service.js';

// Routes accessibles sans session
// Routes qui n'indiquent PAS que l'application est utilisée (diagnostic)
const NO_PRESENCE_ROUTES = new Set(['/api/debug/linkedin']);
const LIVE_ROUTE = '/api/infrastructure/live';
const PUBLIC_ROUTES = new Set(['/api/health', '/api/auth/login', '/api/auth/logout', '/api/auth/session', '/api/auth/:platform/callback']);

class HttpError extends Error {
  constructor(status, error, message, extra = {}) { super(message); Object.assign(this, { status, error, extra }); }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * @param {object} deps
 * @param {object} [deps.service]        DataService déjà construit (tests)
 * @param {Function} [deps.createService] fabrique (logger) => DataService, pour partager le logger Fastify
 */
export function buildApp({ cfg, store, providers, service, createService, now = () => Date.now(), logger = true, logStream, failDelayMs = 400, dokploy, presence, scheduler, dokployLive }) {
  const app = Fastify({
    trustProxy: true, // l'API n'est joignable que via le nginx du compose (réseau interne)
    bodyLimit: 16 * 1024,
    logger: logger && {
      level: process.env.LOG_LEVEL || 'info',
      // Jamais de query string (code OAuth, state), de cookies ni d'en-têtes dans les logs
      serializers: {
        req: (req) => ({ method: req.method, url: String(req.url).split('?')[0], ip: req.ip }),
        res: (res) => ({ statusCode: res.statusCode })
      },
      redact: ['req.headers', 'headers', '*.accessToken', '*.refreshToken', '*.access_token', '*.refresh_token', '*.client_secret'],
      ...(logStream ? { stream: logStream } : {})
    }
  });

  if (!service) service = createService(app.log);
  app.decorate('service', service);
  dokploy ||= new DokployClient(cfg.dokploy, { now });
  app.decorate('dokploy', dokploy);
  app.addHook('onClose', async () => dokploy.close?.());
  presence ||= new Presence({ windowMs: cfg.live.activeWindowSeconds * 1000, now });
  app.decorate('presence', presence);
  dokployLive ||= new DokployLive({ client: dokploy, now, metricsTtlMs: cfg.live.dokployMetricsTtlMs, statusTtlMs: cfg.live.dokployStatusTtlMs, runningTtlMs: cfg.live.dokployRunningTtlMs });
  app.decorate('dokployLive', dokployLive);
  // Arrêt propre (SIGTERM) : plus aucun cycle en direct, lectures en cours attendues (bornées), cache persistant écrit.
  app.addHook('onClose', async () => { scheduler?.stop(); await service.close?.(); });

  const limiter = new LoginLimiter({ maxAttempts: cfg.loginMaxAttempts, windowMs: cfg.loginWindowMinutes * 60_000, now });
  const states = new OAuthStates({ now });
  const infraHits = new Map();
  const liveHits = new Map(); // bucket séparé pour /api/infrastructure/live : n'entame jamais le quota des autres routes Dokploy
  const publicOrigin = new URL(cfg.publicUrl).origin;
  const sessionTtlMs = cfg.sessionTtlHours * 3_600_000;
  const cookieOpts = { secure: cfg.secureCookies };

  const redirectToApp = (reply, params, hash = '') => {
    const q = new URLSearchParams(params).toString();
    return reply.redirect(`${cfg.publicUrl}/${q ? `?${q}` : ''}${hash}`, 302);
  };

  // Server-Timing : durées par étape (aucune donnée sensible : uniquement des noms d'étapes et des millisecondes)
  const timed = async (req, name, fn) => {
    const t0 = performance.now();
    try { return await fn(); } finally { if (req.timing) req.timing.marks.push([name, performance.now() - t0]); }
  };

  // --------------------------------------------------------------------- Hooks
  app.addHook('onRequest', async (req, reply) => {
    req.timing = { start: performance.now(), marks: [] };
    reply.header('Cache-Control', 'no-store');
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'no-referrer');

    // Anti-CSRF : toute requête modifiante doit venir de la même origine
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      const origin = req.headers.origin;
      const site = req.headers['sec-fetch-site'];
      if ((origin && origin !== publicOrigin) || site === 'cross-site') {
        throw new HttpError(403, 'forbidden_origin', 'Origine non autorisée.');
      }
    }
    // CORS fermé : aucun en-tête Access-Control-* n'est émis ; les pré-requêtes sont refusées
    if (req.method === 'OPTIONS') throw new HttpError(405, 'method_not_allowed', 'Méthode non autorisée.');

    const route = req.routeOptions && req.routeOptions.url;
    if (route && PUBLIC_ROUTES.has(route)) return;
    const session = verifySession(parseCookies(req.headers.cookie)[SESSION_COOKIE], cfg.sessionSecret, now());
    if (!session) throw new HttpError(401, 'unauthenticated', 'Authentification requise.');
    req.session = session;
    req.timing.marks.push(['auth', performance.now() - req.timing.start]);
    // Présence : toute requête authentifiée (hors diagnostic) signale que l'application est utilisée.
    if (!NO_PRESENCE_ROUTES.has(route)) presence.touch();

    // Rate limit léger des routes Dokploy : 30 requêtes par minute et par session ; /live a son propre bucket (LIVE_RATE_LIMIT_PER_MINUTE)
    if (/^\/api\/(infrastructure|deployments)(\/|\?|$)/.test(req.url)) {
      const t = now();
      const isLive = route === LIVE_ROUTE;
      const hits = isLive ? liveHits : infraHits;
      const limit = isLive ? cfg.live.rateLimitPerMinute : 30;
      let slot = hits.get(session.sid);
      if (!slot || slot.resetAt <= t) { slot = { count: 0, resetAt: t + 60_000 }; hits.set(session.sid, slot); }
      if (++slot.count > limit) {
        const wait = Math.ceil((slot.resetAt - t) / 1000);
        reply.header('Retry-After', String(wait));
        throw new HttpError(429, 'too_many_requests', `Trop de requêtes. Réessayez dans ${wait} s.`, { retryAfter: wait });
      }
      if (hits.size > 500) for (const [k, v] of hits) if (v.resetAt <= t) hits.delete(k);
    }
  });

  app.addHook('onSend', async (req, reply, payload) => {
    if (req.timing && req.timing.marks.length > 1) {
      const parts = req.timing.marks.map(([n, ms]) => `${n};dur=${ms.toFixed(1)}`);
      parts.push(`total;dur=${(performance.now() - req.timing.start).toFixed(1)}`);
      reply.header('Server-Timing', parts.join(', '));
    }
    return payload;
  });

  // Durée des routes dans les journaux pino : route (sans query), statut, millisecondes, étapes. Aucun secret.
  app.addHook('onResponse', async (req, reply) => {
    const route = req.routeOptions && req.routeOptions.url;
    if (!req.timing || !route || PUBLIC_ROUTES.has(route)) return;
    const ms = Math.round(performance.now() - req.timing.start);
    req.log[ms > 1000 ? 'warn' : 'debug']({ route, statusCode: reply.statusCode, ms, steps: Object.fromEntries(req.timing.marks.map(([n, d]) => [n, Math.round(d)])) }, 'durée de la route');
  });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof DokployError) return reply.code(err.status).send({ error: err.code, message: err.message });
    if (err instanceof HttpError) return reply.code(err.status).send({ error: err.error, message: err.message, ...err.extra });
    if (err instanceof ProviderError) {
      return reply.code(502).send({ error: 'provider_error', platform: err.platform, code: err.code, message: err.message });
    }
    if (err.validation || err.statusCode === 400 || err.statusCode === 415 || err.statusCode === 413) {
      return reply.code(err.statusCode || 400).send({ error: 'bad_request', message: 'Requête invalide.' });
    }
    req.log.error({ err: { message: err.message, stack: err.stack } }, 'erreur interne');
    return reply.code(500).send({ error: 'internal', message: 'Erreur interne.' });
  });

  app.setNotFoundHandler((req, reply) => reply.code(404).send({ error: 'not_found', message: 'Route inconnue.' }));

  const platformParam = (req) => {
    const p = req.params.platform;
    if (!PLATFORMS.includes(p)) throw new HttpError(404, 'unknown_platform', `Plateforme inconnue : ${String(p).slice(0, 20)}`);
    return p;
  };

  // --------------------------------------------------------------------- Santé & session
  app.get('/api/health', async () => ({ ok: true, time: new Date(now()).toISOString() }));

  app.get('/api/auth/session', async (req) => ({
    authenticated: Boolean(verifySession(parseCookies(req.headers.cookie)[SESSION_COOKIE], cfg.sessionSecret, now()))
  }));

  app.post('/api/auth/login', async (req, reply) => {
    const ip = req.ip;
    const wait = limiter.retryAfter(ip);
    if (wait > 0) {
      reply.header('Retry-After', String(wait));
      throw new HttpError(429, 'too_many_attempts', `Trop de tentatives. Réessayez dans ${Math.ceil(wait / 60)} min.`, { retryAfter: wait });
    }
    const password = req.body && typeof req.body.password === 'string' ? req.body.password.slice(0, 256) : '';
    if (!password || !safeEqual(password, cfg.dashboardPassword)) {
      limiter.fail(ip);
      req.log.warn({ ip }, 'échec de connexion');
      if (failDelayMs) await sleep(failDelayMs);
      throw new HttpError(401, 'invalid_credentials', 'Mot de passe incorrect.');
    }
    limiter.succeed(ip);
    reply.header('Set-Cookie', serializeCookie(SESSION_COOKIE, createSession(cfg.sessionSecret, sessionTtlMs, now()), { ...cookieOpts, maxAge: sessionTtlMs / 1000 }));
    return { ok: true };
  });

  app.post('/api/auth/logout', async (req, reply) => {
    reply.header('Set-Cookie', serializeCookie(SESSION_COOKIE, '', { ...cookieOpts, maxAge: 0 }));
    return { ok: true };
  });

  // --------------------------------------------------------------------- Statut
  app.get('/api/status', async (req) => ({
    mode: 'api',
    mockFallback: cfg.mockFallback,
    cacheTtlSeconds: cfg.cacheTtlSeconds,
    serverTime: new Date(now()).toISOString(),
    live: {
      enabled: cfg.live.enabled,
      ...presence.snapshot(),
      persistCache: cfg.persistCache,
      intervals: { instagram: { lightSeconds: cfg.live.instagramLightSeconds, heavySeconds: cfg.live.instagramHeavySeconds }, tiktok: { lightSeconds: cfg.live.tiktokLightSeconds, heavySeconds: cfg.live.tiktokHeavySeconds } }
    },
    platforms: await timed(req, 'status', () => service.status())
  }));

  // Battement de présence : l'application est ouverte. Session + contrôle d'origine (hook) ; aucune donnée en retour.
  app.post('/api/live/ping', async (req, reply) => reply.code(204).send());

  app.get('/api/infrastructure', async () => dokploy.snapshot());
  // Charge utile PETITE, rafraîchie à haute fréquence par l'application ouverte (le snapshot complet reste /api/infrastructure).
  app.get(LIVE_ROUTE, async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    return timed(req, 'dokploy', () => dokployLive.read());
  });
  app.get('/api/deployments/:id/logs', async (req) => dokploy.logs(req.params.id));
  app.post('/api/infrastructure/services/:type/:id/redeploy', async (req, reply) => {
    const result = await dokploy.redeploy(req.params.type, req.params.id, req.body?.confirmed);
    return reply.code(202).send(result);
  });
  app.post('/api/infrastructure/services/application/:id/reload', async (req, reply) => {
    const result = await dokploy.reload(req.params.id, req.body?.confirmed);
    return reply.code(202).send(result);
  });
  app.get('/api/infrastructure/operations/:id', async (req) => dokploy.operation(req.params.id));

  // --------------------------------------------------------------------- OAuth
  app.get('/api/auth/:platform/login', async (req, reply) => {
    const platform = platformParam(req);
    if (!platformConfigured(cfg, platform)) {
      return redirectToApp(reply, { oauth_error: platform, reason: 'not_configured' }, `#/${platform}`);
    }
    // LinkedIn non approuvé : on ne lance pas un OAuth voué à l'échec (aucun scope accordé)
    if (providers[platform].pendingApproval) {
      return redirectToApp(reply, { oauth_error: platform, reason: 'pending_approval' }, `#/${platform}`);
    }
    const { state, nonce } = states.create(platform);
    reply.header('Set-Cookie', serializeCookie(OAUTH_COOKIE, nonce, { ...cookieOpts, maxAge: 600, path: '/api/auth/' }));
    return reply.redirect(providers[platform].authorizeUrl(state), 302);
  });

  app.get('/api/auth/:platform/callback', async (req, reply) => {
    const platform = platformParam(req);
    const { code, state, error } = req.query || {};
    reply.header('Set-Cookie', serializeCookie(OAUTH_COOKIE, '', { ...cookieOpts, maxAge: 0, path: '/api/auth/' }));
    const nonce = parseCookies(req.headers.cookie)[OAUTH_COOKIE];
    const entry = states.consume(typeof state === 'string' ? state : '', platform, nonce);
    if (!entry) {
      req.log.warn({ platform }, 'callback OAuth : state invalide ou expiré');
      return redirectToApp(reply, { oauth_error: platform, reason: 'invalid_state' }, `#/${platform}`);
    }
    if (error || typeof code !== 'string' || !code) {
      return redirectToApp(reply, { oauth_error: platform, reason: error ? 'denied' : 'missing_code' }, `#/${platform}`);
    }
    try {
      const token = await providers[platform].exchangeCode(code);
      await store.setToken(platform, token);
      await store.setTokenMeta(platform, null); // nouvelle connexion : l'historique de renouvellement repart de zéro
      service.forget(platform);
      req.log.info({ platform }, 'compte connecté');
      return redirectToApp(reply, { connected: platform }, `#/${platform}`);
    } catch (err) {
      req.log.warn({ platform, code: err.code }, `échange du code OAuth en échec : ${err.message}`);
      return redirectToApp(reply, { oauth_error: platform, reason: 'token_exchange' }, `#/${platform}`);
    }
  });

  // Déconnexion d'une plateforme : révocation côté plateforme (si elle le permet), puis suppression
  // du token ET de l'historique (instantanés de followers) de cette plateforme, et vidage du cache mémoire.
  app.post('/api/auth/:platform/disconnect', async (req) => {
    const platform = platformParam(req);
    const token = await store.getToken(platform);
    if (token) {
      try { await providers[platform].revoke(token); } catch (err) {
        req.log.warn({ platform }, `révocation distante en échec (token supprimé localement quand même) : ${err.message}`);
      }
    }
    await store.clearPlatform(platform);
    service.forget(platform);
    req.log.info({ platform }, 'compte déconnecté, données locales supprimées');
    return { ok: true, platform };
  });

  // --------------------------------------------------------------------- Données (mêmes formes que js/api.js)
  const periodOf = (req) => agg.clampPeriod(req.query && req.query.period);

  // Fraîcheur agrégée des plateformes connectées : { updatedAt, stale, refreshing, loading, platformsUpdatedAt }.
  const ACTIVE = ['connected', 'limited'];
  const freshnessOf = (d, only = PLATFORMS) => {
    const rows = only.map((p) => [p, d.platforms[p]]).filter(([, s]) => s && ACTIVE.includes(s.status));
    const times = rows.map(([, s]) => s.updatedAt).filter(Boolean).sort();
    return {
      updatedAt: times.length ? times[times.length - 1] : null,
      stale: rows.some(([, s]) => s.stale),
      refreshing: rows.some(([, s]) => s.refreshing),
      loading: rows.flatMap(([p, s]) => (s.loading || []).map((b) => `${p}:${b}`)),
      platformsUpdatedAt: Object.fromEntries(rows.map(([p, s]) => [p, s.updatedAt || null]))
    };
  };
  const dataset = (req) => timed(req, 'dataset', () => service.dataset());

  function assertAvailable(d, platform) {
    const s = d.platforms[platform];
    if (s.status === 'pending_approval') {
      throw new HttpError(409, 'pending_approval', s.message || "En attente d'approbation LinkedIn.", { platform, steps: s.pendingSteps || [] });
    }
    if (s.status === 'not_connected') {
      throw new HttpError(409, 'not_connected', `${LABELS[platform]} n'est pas connecté.`, { platform, configured: platformConfigured(cfg, platform) });
    }
    if (s.status === 'expired') throw new HttpError(409, 'token_expired', s.message || 'Token expiré : reconnectez le compte.', { platform });
    if (s.status === 'error') throw new HttpError(502, 'provider_error', s.message || 'Erreur de la plateforme.', { platform });
  }

  app.get('/api/accounts', async (req) => agg.accounts(await dataset(req)));

  // Réponse immédiate depuis le cache (même périmé) : updatedAt, stale, refreshing, loading ; la revalidation part en fond.
  app.get('/api/overview', async (req) => {
    const d = await dataset(req);
    return timed(req, 'aggregate', () => ({ ...agg.overview(d, periodOf(req)), sources: d.platforms, ...freshnessOf(d) }));
  });

  app.get('/api/platforms/:platform/stats', async (req) => {
    const platform = platformParam(req);
    const d = await dataset(req);
    assertAvailable(d, platform);
    const s = d.platforms[platform];
    return timed(req, 'aggregate', () => ({
      ...agg.platformStats(d, platform, periodOf(req)),
      source: s,
      // Projection par liste blanche : aucun objet fournisseur brut n'est relayé
      details: projectDetails(platform, d.details && d.details[platform]),
      coverage: coverageOf(platform, d.details && d.details[platform]),
      updatedAt: s.updatedAt || null, // dernière récupération RÉELLE auprès de la plateforme (n'importe quel palier)
      heavyUpdatedAt: s.heavyUpdatedAt ?? null, // dernier palier lourd (insights par média, audience, commentaires)
      stale: Boolean(s.stale),
      refreshing: Boolean(s.refreshing),
      loading: s.loading || [],
      cacheTtlSeconds: service.cacheTtlSeconds(platform)
    }));
  });

  // Actualisation manuelle d'une plateforme : session + origine (hook) ; 6/min par session, 60 s minimum par plateforme.
  const refreshHits = new Map();
  const REFRESH_MIN_GAP_MS = 60_000;
  app.post('/api/platforms/:platform/refresh', async (req, reply) => {
    const platform = platformParam(req);
    const t = now();
    let slot = refreshHits.get(req.session.sid);
    if (!slot || slot.resetAt <= t) { slot = { count: 0, resetAt: t + 60_000 }; refreshHits.set(req.session.sid, slot); }
    if (++slot.count > 6) {
      const wait = Math.ceil((slot.resetAt - t) / 1000);
      reply.header('Retry-After', String(wait));
      throw new HttpError(429, 'too_many_requests', `Trop d'actualisations. Réessayez dans ${wait} s.`, { retryAfter: wait });
    }
    if (refreshHits.size > 500) for (const [k, v] of refreshHits) if (v.resetAt <= t) refreshHits.delete(k);

    if (providers[platform].pendingApproval) {
      throw new HttpError(409, 'pending_approval', "En attente d'approbation LinkedIn.", { platform });
    }
    if (!(await store.getToken(platform))) {
      throw new HttpError(409, 'not_connected', `${LABELS[platform]} n'est pas connecté.`, { platform, configured: platformConfigured(cfg, platform) });
    }
    const last = service.lastManualRefresh[platform];
    if (last && t - last < REFRESH_MIN_GAP_MS) {
      const wait = Math.ceil((REFRESH_MIN_GAP_MS - (t - last)) / 1000);
      reply.header('Retry-After', String(wait));
      throw new HttpError(429, 'refresh_too_soon', `${LABELS[platform]} a été actualisé il y a moins d'une minute. Réessayez dans ${wait} s.`, { retryAfter: wait, platform });
    }
    service.lastManualRefresh[platform] = t;
    try {
      const r = await service.refreshPlatform(platform);
      return {
        ok: true,
        platform,
        status: r.status, // 'refreshed' | 'budget_exhausted'
        refreshed: r.refreshed,
        updatedAt: r.updatedAt,
        budget: r.budget,
        message: r.status === 'budget_exhausted'
          ? `Budget d'appels ${LABELS[platform]} du jour atteint : les données précédentes sont conservées${r.budget ? ` (réinitialisation ${r.budget.resetsAt})` : ''}.`
          : null
      };
    } catch (err) {
      if (err instanceof ProviderError && err.code === 'auth') throw new HttpError(409, 'token_expired', err.message, { platform });
      throw err;
    }
  });

  // Renouvellement manuel du JETON (pas des données) : session + origine (hook) ; 6/min par session, 30 s minimum par plateforme.
  const renewHits = new Map();
  const RENEW_MIN_GAP_MS = 30_000;
  app.post('/api/platforms/:platform/token/refresh', async (req, reply) => {
    const platform = platformParam(req);
    const t = now();
    let slot = renewHits.get(req.session.sid);
    if (!slot || slot.resetAt <= t) { slot = { count: 0, resetAt: t + 60_000 }; renewHits.set(req.session.sid, slot); }
    if (++slot.count > 6) {
      const wait = Math.ceil((slot.resetAt - t) / 1000);
      reply.header('Retry-After', String(wait));
      throw new HttpError(429, 'too_many_requests', `Trop de renouvellements. Réessayez dans ${wait} s.`, { retryAfter: wait });
    }
    if (renewHits.size > 500) for (const [k, v] of renewHits) if (v.resetAt <= t) renewHits.delete(k);

    if (providers[platform].pendingApproval) throw new HttpError(409, 'pending_approval', "En attente d'approbation LinkedIn.", { platform });
    if (!(await store.getToken(platform))) {
      throw new HttpError(409, 'not_connected', `${LABELS[platform]} n'est pas connecté.`, { platform, configured: platformConfigured(cfg, platform) });
    }
    const last = service.lastManualRenew[platform];
    if (last && t - last < RENEW_MIN_GAP_MS) {
      const wait = Math.ceil((RENEW_MIN_GAP_MS - (t - last)) / 1000);
      reply.header('Retry-After', String(wait));
      throw new HttpError(429, 'refresh_too_soon', `Le jeton ${LABELS[platform]} a été renouvelé il y a moins de 30 s. Réessayez dans ${wait} s.`, { retryAfter: wait, platform });
    }
    service.lastManualRenew[platform] = t;
    try {
      const r = await service.renewToken(platform, { manual: true });
      const tk = r.token;
      return {
        ok: true,
        platform,
        renewed: true,
        expiresAt: new Date(tk.expiresAt).toISOString(),
        refreshExpiresAt: tk.refreshExpiresAt ? new Date(tk.refreshExpiresAt).toISOString() : null,
        renewedAt: r.renewedAt,
        message: `Jeton ${LABELS[platform]} renouvelé.`
      };
    } catch (err) {
      if (err instanceof RenewError) {
        if (err.code === 'too_soon' && err.extra.retryAfter) reply.header('Retry-After', String(err.extra.retryAfter));
        throw new HttpError(err.code === 'upstream' ? 502 : 409, err.code, err.message, { platform, ...err.extra });
      }
      req.log.warn({ platform, code: err && err.code }, 'renouvellement manuel du jeton en échec');
      throw new HttpError(502, 'upstream', `${LABELS[platform]} est momentanément injoignable.`, { platform });
    }
  });

  // Insights du compte (Instagram) : vues, interactions, profil, audience. Une métrique en échec est simplement absente.
  app.get('/api/platforms/:platform/insights', async (req) => {
    const platform = platformParam(req);
    if (!service.supportsInsights(platform)) {
      throw new HttpError(404, 'insights_unavailable', `Insights de compte non pris en charge pour ${LABELS[platform]}.`, { platform });
    }
    const d = await dataset(req);
    assertAvailable(d, platform);
    try {
      return { ...(await timed(req, 'insights', () => service.insights(platform, periodOf(req), d))), source: d.platforms[platform] };
    } catch (err) {
      if (err instanceof ProviderError && err.code === 'auth') throw new HttpError(409, 'token_expired', err.message, { platform });
      throw err;
    }
  });

  app.get('/api/posts', async (req, reply) => {
    const q = req.query || {};
    const platform = q.platform ? String(q.platform) : '';
    if (platform && !PLATFORMS.includes(platform)) throw new HttpError(404, 'unknown_platform', 'Plateforme inconnue.');
    const d = await dataset(req);
    if (platform) assertAvailable(d, platform);
    // Le corps reste un tableau (contrat historique) : la fraîcheur voyage dans des en-têtes X-Data-*.
    const f = freshnessOf(d, platform ? [platform] : PLATFORMS);
    if (f.updatedAt) reply.header('X-Data-Updated-At', f.updatedAt);
    reply.header('X-Data-Stale', String(f.stale));
    reply.header('X-Data-Refreshing', String(f.refreshing));
    if (f.loading.length) reply.header('X-Data-Loading', f.loading.join(','));
    return timed(req, 'aggregate', () => agg.posts(d, { platform, period: periodOf(req), sort: String(q.sort || 'publishedAt'), limit: q.limit }));
  });

  app.get('/api/comments', async (req) => {
    const q = req.query || {};
    const platform = q.platform && PLATFORMS.includes(String(q.platform)) ? String(q.platform) : '';
    const sentiment = ['positive', 'neutral', 'negative'].includes(q.sentiment) ? q.sentiment : '';
    const d = await dataset(req);
    const res = agg.comments(d, { platform, sentiment, q: String(q.q || '').slice(0, 200), period: periodOf(req), limit: q.limit });
    const unavailable = PLATFORMS
      .filter((p) => !d.platforms[p].commentsAvailable || ['error', 'expired'].includes(d.platforms[p].status))
      .map((p) => ({
        platform: p,
        status: d.platforms[p].status,
        reason: d.platforms[p].status === 'pending_approval'
          ? "Commentaires LinkedIn indisponibles : en attente d'approbation de la Community Management API."
          : p === 'tiktok' && d.platforms[p].status !== 'error' && d.platforms[p].status !== 'expired'
          ? "Commentaires non disponibles pour TikTok : l'API Display ne les fournit pas."
          : d.platforms[p].message || (d.platforms[p].notes || [])[0] || 'Commentaires non disponibles.'
      }));
    // Les commentaires ne sont jamais persistés : après un redémarrage ils reviennent avec le palier lourd.
    for (const p of PLATFORMS) {
      if ((d.platforms[p].loading || []).includes('comments') && !unavailable.some((u) => u.platform === p)) {
        unavailable.push({ platform: p, status: d.platforms[p].status, reason: 'Commentaires en cours de chargement : ils ne sont pas conservés sur disque et reviennent avec la prochaine lecture complète.' });
      }
    }
    return { ...res, unavailable, ...freshnessOf(d) };
  });

  // --------------------------------------------------------------------- Diagnostic LinkedIn (protégé par la session)
  // Teste un à un les appels organisation et indique l'étape qui échoue. Ne renvoie jamais de token ni de secret.
  app.get('/api/debug/linkedin', async () => {
    const c = cfg.linkedin;
    const token = await store.getToken('linkedin');
    const config = {
      clientIdSet: Boolean(c.clientId),
      clientSecretSet: Boolean(c.clientSecret),
      organizationId: c.organizationId || null,
      communityApi: c.communityApi,
      scopes: c.scopes.split(/[\s,]+/).filter(Boolean),
      apiVersion: c.apiVersion,
      redirectUri: c.redirectUri
    };
    const tokenInfo = token ? {
      present: true,
      expiresAt: new Date(token.expiresAt).toISOString(),
      expired: token.expiresAt <= now(),
      grantedScopes: String(token.scope || '').split(/[\s,]+/).filter(Boolean),
      refreshable: Boolean(token.refreshToken)
    } : { present: false };

    const blocking = [];
    if (!config.clientIdSet || !config.clientSecretSet) blocking.push('LINKEDIN_CLIENT_ID / LINKEDIN_CLIENT_SECRET manquants.');
    if (!config.organizationId) blocking.push('LINKEDIN_ORGANIZATION_ID manquant.');
    if (!config.communityApi) blocking.push("LINKEDIN_COMMUNITY_API=false : en attente d'approbation (aucun appel effectué).");
    if (config.communityApi && !tokenInfo.present) blocking.push('Aucun token : cliquez « Connecter LinkedIn ».');
    if (tokenInfo.expired) blocking.push('Token expiré : reconnectez LinkedIn.');

    let calls = [];
    if (!blocking.length) calls = await providers.linkedin.diagnose(token);
    const failed = calls.find((x) => x.ok === false);
    return {
      config,
      token: tokenInfo,
      status: blocking.length ? 'blocked' : failed ? 'failed' : 'ok',
      blocking,
      calls,
      firstFailure: blocking[0] || (failed ? `${failed.step} (scope ${failed.scope}) : ${failed.httpStatus || ''} ${failed.message}` : null),
      pendingSteps: config.communityApi ? [] : linkedinPendingSteps(cfg)
    };
  });

  return app;
}
