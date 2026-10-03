// Intégration (hors réseau) : actualisation manuelle, persistance des jetons, rétention LinkedIn, secrets, auth/origine.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeApp, login, stubProvider, TEST_KEY, TEST_SECRET, TEST_PASSWORD } from './helpers.js';
import { platformRoutes, TT_ACCESS } from './fixtures.js';
import { decrypt } from '../src/crypto.js';
import { ProviderError } from '../src/http.js';
import { DAY, CANARY, tiktokRaw, instagramRaw, linkedinRaw } from './integration-fixtures.js';

const T0 = Date.parse('2026-09-30T10:00:00Z');
const ORIGIN = 'https://dash.example.test';
const tok = (extra = {}) => ({ accessToken: CANARY.access, refreshToken: CANARY.refresh, expiresAt: T0 + 20 * DAY, ...extra });
const readStore = (ctx) => decrypt(JSON.parse(fs.readFileSync(path.join(ctx.cfg.dataDir, 'store.enc.json'), 'utf8')), TEST_KEY);

async function setup({ platforms = ['tiktok', 'instagram', 'linkedin'], clock, env = {}, liRaw } = {}) {
  const now = clock || (() => T0);
  const providers = {
    tiktok: stubProvider('tiktok', () => tiktokRaw(now())),
    instagram: stubProvider('instagram', () => instagramRaw(now())),
    linkedin: stubProvider('linkedin', liRaw || (() => linkedinRaw(now())))
  };
  const ctx = makeApp({ providers, now, env: { LINKEDIN_COMMUNITY_API: 'true', LINKEDIN_ORGANIZATION_ID: '1', ...env } });
  for (const p of platforms) await ctx.store.setToken(p, tok());
  ctx.cookie = await login(ctx.app);
  ctx.providers = providers;
  ctx.post = (url, headers = {}) => ctx.app.inject({ method: 'POST', url, headers: { cookie: ctx.cookie, origin: ORIGIN, ...headers }, payload: {} });
  ctx.get = (url) => ctx.app.inject({ url, headers: { cookie: ctx.cookie } });
  return ctx;
}

// ---------------------------------------------------------------------------- Actualisation manuelle
test('refresh : 401 sans session, 403 origine étrangère, 404 plateforme inconnue', async () => {
  const ctx = await setup();
  const noSession = await ctx.app.inject({ method: 'POST', url: '/api/platforms/tiktok/refresh', headers: { origin: ORIGIN }, payload: {} });
  assert.equal(noSession.statusCode, 401);
  const foreign = await ctx.post('/api/platforms/tiktok/refresh', { origin: 'https://evil.example.com' });
  assert.equal(foreign.statusCode, 403);
  assert.equal(foreign.json().error, 'forbidden_origin');
  const crossSite = await ctx.post('/api/platforms/tiktok/refresh', { 'sec-fetch-site': 'cross-site' });
  assert.equal(crossSite.statusCode, 403);
  const unknown = await ctx.post('/api/platforms/facebook/refresh');
  assert.equal(unknown.statusCode, 404);
  assert.equal(unknown.json().error, 'unknown_platform');
  assert.equal(ctx.providers.tiktok.calls.fetch, 0, 'aucun appel plateforme pour une requête refusée');
});

test('refresh : invalide le cache, relit, renvoie statut + updatedAt réel ; non connecté -> 409', async () => {
  let t = T0;
  const ctx = await setup({ platforms: ['tiktok'], clock: () => t });
  await ctx.get('/api/platforms/tiktok/stats');
  assert.equal(ctx.providers.tiktok.calls.fetch, 1);
  t += 5 * 60_000; // toujours dans le TTL de 15 min : seul le refresh manuel force la relecture
  const r = await ctx.post('/api/platforms/tiktok/refresh');
  assert.equal(r.statusCode, 200);
  assert.deepEqual(r.json(), { ok: true, platform: 'tiktok', status: 'refreshed', refreshed: true, updatedAt: new Date(t).toISOString(), budget: null, message: null });
  assert.equal(ctx.providers.tiktok.calls.fetch, 2);
  const stats = (await ctx.get('/api/platforms/tiktok/stats')).json();
  assert.equal(stats.updatedAt, new Date(t).toISOString());
  assert.equal(ctx.providers.tiktok.calls.fetch, 2, 'données relues servies ensuite depuis le cache');

  const nc = await ctx.post('/api/platforms/instagram/refresh');
  assert.equal(nc.statusCode, 409);
  assert.equal(nc.json().error, 'not_connected');
  assert.equal(ctx.providers.instagram.calls.fetch, 0);
});

test('refresh : 429 par plateforme (60 s) avec Retry-After, puis autorisé après 60 s', async () => {
  let t = T0;
  const ctx = await setup({ platforms: ['tiktok', 'instagram'], clock: () => t });
  assert.equal((await ctx.post('/api/platforms/tiktok/refresh')).statusCode, 200);
  t += 10_000;
  const second = await ctx.post('/api/platforms/tiktok/refresh');
  assert.equal(second.statusCode, 429);
  assert.equal(second.json().error, 'refresh_too_soon');
  assert.equal(second.json().retryAfter, 50);
  assert.equal(second.headers['retry-after'], '50');
  assert.match(second.json().message, /Réessayez dans 50 s/);
  assert.equal(ctx.providers.tiktok.calls.fetch, 1);
  assert.equal((await ctx.post('/api/platforms/instagram/refresh')).statusCode, 200, "l'autre plateforme n'est pas bloquée");
  t += 51_000;
  assert.equal((await ctx.post('/api/platforms/tiktok/refresh')).statusCode, 200);
});

test('refresh : 429 par session au-delà de 6 actualisations par minute', async () => {
  let t = T0;
  const ctx = await setup({ platforms: ['tiktok'], clock: () => t });
  const codes = [];
  for (let i = 0; i < 8; i++) codes.push((await ctx.post('/api/platforms/tiktok/refresh')).statusCode);
  assert.deepEqual(codes, [200, 429, 429, 429, 429, 429, 429, 429]);
  const lastBody = (await ctx.post('/api/platforms/tiktok/refresh')).json();
  assert.equal(lastBody.error, 'too_many_requests');
  t += 61_000;
  assert.equal((await ctx.post('/api/platforms/tiktok/refresh')).statusCode, 200, 'fenêtre de 1 min écoulée');
});

test('refresh LinkedIn : budget connu épuisé -> aucun appel, données conservées, réponse explicite', async () => {
  const exhausted = linkedinRaw(T0, { budget: { used: 80, limit: 80, resetsAt: new Date(T0 + DAY).toISOString() } });
  const ctx = await setup({ platforms: ['linkedin'], liRaw: () => exhausted });
  await ctx.get('/api/platforms/linkedin/stats');
  assert.equal(ctx.providers.linkedin.calls.fetch, 1);
  const r = await ctx.post('/api/platforms/linkedin/refresh');
  assert.equal(r.statusCode, 200);
  const b = r.json();
  assert.equal(b.status, 'budget_exhausted');
  assert.equal(b.refreshed, false);
  assert.deepEqual(b.budget, { used: 80, limit: 80, resetsAt: new Date(T0 + DAY).toISOString() });
  assert.match(b.message, /Budget d'appels LinkedIn/);
  assert.equal(ctx.providers.linkedin.calls.fetch, 1, 'le refresh manuel ne contourne pas le budget');
  assert.equal(b.updatedAt, new Date(T0).toISOString());
});

test('refresh LinkedIn : relecture amputée par le budget -> données complètes précédentes conservées', async () => {
  let n = 0;
  const liRaw = () => {
    n++;
    if (n === 1) return linkedinRaw(T0, { budget: { used: 40, limit: 80, resetsAt: new Date(T0 + DAY).toISOString() } });
    const degraded = linkedinRaw(T0, { budget: { used: 80, limit: 80, resetsAt: new Date(T0 + DAY).toISOString() }, blocks: { posts: { state: 'budget_exhausted', reason: 'budget' } } });
    degraded.posts = [];
    return degraded;
  };
  const ctx = await setup({ platforms: ['linkedin'], liRaw });
  await ctx.get('/api/platforms/linkedin/stats');
  const r = (await ctx.post('/api/platforms/linkedin/refresh')).json();
  assert.equal(r.status, 'budget_exhausted');
  assert.equal(r.refreshed, false);
  const posts = (await ctx.get('/api/posts?platform=linkedin')).json();
  assert.equal(posts.length, 2, 'publications précédentes conservées');
  assert.equal(n, 2, 'une seule relecture, pas de boucle');
});

test('refresh : jeton expiré -> 409 token_expired ; erreur plateforme -> 502', async () => {
  const ctx = await setup({ platforms: ['tiktok', 'instagram'] });
  ctx.providers.tiktok.fetchData = async () => { throw new ProviderError('tiktok', 'auth', 'Jeton invalide'); };
  ctx.providers.instagram.fetchData = async () => { throw new ProviderError('instagram', 'http', 'Erreur Meta', 500); };
  const a = await ctx.post('/api/platforms/tiktok/refresh');
  assert.equal(a.statusCode, 409);
  assert.equal(a.json().error, 'token_expired');
  const b = await ctx.post('/api/platforms/instagram/refresh');
  assert.equal(b.statusCode, 502);
  assert.ok(!a.body.includes(CANARY.access) && !b.body.includes(CANARY.access));
});

// ---------------------------------------------------------------------------- Persistance du refresh token TikTok
test('TikTok : le refresh persiste l’objet complet (nouveau refreshToken + refreshExpiresAt)', async () => {
  const t = T0;
  const fetch = platformRoutes(t);
  const ctx = makeApp({ fetch, now: () => t, env: { TIKTOK_RETRY_DELAY_MS: '0' } });
  await ctx.store.setToken('tiktok', { accessToken: TT_ACCESS, refreshToken: 'rft.old', refreshExpiresAt: t + 10 * DAY, userId: 'open-1', expiresAt: t + 30 * 60_000, scope: 'user.info.basic,video.list' });
  const cookie = await login(ctx.app);
  const r = await ctx.app.inject({ url: '/api/platforms/tiktok/stats', headers: { cookie } });
  assert.equal(r.statusCode, 200);
  const saved = await ctx.store.getToken('tiktok');
  assert.equal(saved.accessToken, 'act.refreshed');
  assert.equal(saved.refreshToken, 'rft.refreshed', 'le NOUVEAU refresh token remplace l’ancien');
  assert.equal(saved.refreshExpiresAt, t + 31_536_000 * 1000);
  assert.equal(saved.expiresAt, t + 86_400 * 1000);
  assert.equal(saved.userId, 'open-1');
  // relu depuis le disque (persisté et chiffré)
  const onDisk = JSON.parse(readStore(ctx));
  assert.equal(onDisk.tokens.tiktok.refreshToken, 'rft.refreshed');
  assert.equal(onDisk.tokens.tiktok.refreshExpiresAt, t + 31_536_000 * 1000);
  // /status expose les échéances sans jeton
  const st = (await ctx.app.inject({ url: '/api/status', headers: { cookie } })).json().platforms.tiktok;
  assert.equal(st.refreshExpiresAt, new Date(t + 31_536_000 * 1000).toISOString());
  assert.equal(st.expiresAt, new Date(t + 86_400_000).toISOString());
  assert.ok(!JSON.stringify(st).includes('rft.'));
});

// ---------------------------------------------------------------------------- Rétention LinkedIn (48 h)
test('LinkedIn : TTL du cache plafonné à 48 h, commentaires expirés, jamais persistés dans le store', async () => {
  let t = T0;
  const ctx = await setup({ platforms: ['linkedin'], clock: () => t, env: { LINKEDIN_CACHE_TTL_SECONDS: '99999999', CACHE_TTL_SECONDS: '99999999' } });
  assert.equal(ctx.cfg.linkedin.cacheTtlSeconds, 48 * 3600, 'borné par la configuration');
  assert.ok(ctx.service.ttlMs('linkedin') <= 48 * 3_600_000);
  const c1 = (await ctx.get('/api/comments?platform=linkedin')).json();
  assert.equal(c1.items.length, 1);
  assert.equal(c1.items[0].text, CANARY.comment);
  assert.equal(ctx.providers.linkedin.calls.fetch, 1);

  // Rien de LinkedIn dans le fichier chiffré du store (jetons + instantanés de followers seulement)
  const onDisk = readStore(ctx);
  assert.ok(!onDisk.includes(CANARY.comment), 'aucun commentaire LinkedIn persisté');
  assert.deepEqual(Object.keys(JSON.parse(onDisk)).sort(), ['snapshots', 'tokens']);
  assert.ok(!JSON.stringify(ctx.store.state).includes(CANARY.comment));

  // juste avant 48 h : servi depuis le cache ; après 48 h : le cache a expiré et est purgé
  t += 47 * 3_600_000;
  await ctx.app.inject({ url: '/api/comments?platform=linkedin', headers: { cookie: await login(ctx.app) } });
  assert.equal(ctx.providers.linkedin.calls.fetch, 1);
  t += 2 * 3_600_000;
  ctx.cache.purgeExpired();
  assert.equal(ctx.cache.map.has('raw:linkedin'), false, 'entrée expirée retirée de la mémoire');
  await ctx.app.inject({ url: '/api/comments?platform=linkedin', headers: { cookie: await login(ctx.app) } });
  assert.equal(ctx.providers.linkedin.calls.fetch, 2, 'relu après 48 h');
});

test('LinkedIn : garde-fou, des commentaires plus vieux que 48 h ne sont jamais servis même si le TTL était mal réglé', async () => {
  let t = T0;
  const ctx = await setup({ platforms: ['linkedin'], clock: () => t });
  await ctx.get('/api/comments?platform=linkedin');
  ctx.cache.set('raw:linkedin', ctx.cache.get('raw:linkedin'), 10 * 86_400_000); // simulation d'un TTL abusif
  t += 49 * 3_600_000;
  const cookie = await login(ctx.app);
  const c = (await ctx.app.inject({ url: '/api/comments?platform=linkedin', headers: { cookie } })).json();
  assert.equal(c.items.length, 0);
});

test('refreshAll : LinkedIn relu au plus toutes les 12 h par défaut (budget quotidien)', async () => {
  let t = T0;
  const ctx = await setup({ platforms: ['tiktok', 'linkedin'], clock: () => t });
  await ctx.service.refreshAll();
  assert.deepEqual([ctx.providers.tiktok.calls.fetch, ctx.providers.linkedin.calls.fetch], [1, 1]);
  for (let h = 6; h <= 24; h += 6) { // REFRESH_INTERVAL_HOURS=6 : 4 cycles par jour
    t = T0 + h * 3_600_000;
    await ctx.service.refreshAll();
  }
  assert.equal(ctx.providers.tiktok.calls.fetch, 5);
  assert.equal(ctx.providers.linkedin.calls.fetch, 3, 'cycles à 0 h, 12 h, 24 h seulement');
});

// ---------------------------------------------------------------------------- Secrets et contrôles d'accès
const DATA_GET_ROUTES = [
  '/api/platforms/tiktok/stats', '/api/platforms/instagram/stats', '/api/platforms/linkedin/stats',
  '/api/posts', '/api/overview', '/api/status', '/api/comments', '/api/accounts'
];

test('aucun secret (canari) dans les réponses des routes de données', async () => {
  const ctx = await setup({ env: { TIKTOK_CLIENT_SECRET: CANARY.key, INSTAGRAM_APP_SECRET: CANARY.key } });
  const bodies = [];
  for (const url of DATA_GET_ROUTES) bodies.push((await ctx.get(url)).body);
  bodies.push((await ctx.post('/api/platforms/tiktok/refresh')).body);
  const all = bodies.join('\n');
  const secrets = [CANARY.access, CANARY.refresh, CANARY.state, CANARY.key, TEST_KEY, TEST_SECRET, TEST_PASSWORD, 'li-client-secret'];
  for (const secret of secrets) assert.ok(!all.includes(secret), `secret exposé : ${secret.slice(0, 12)}…`);
  assert.ok(!/"(accessToken|refreshToken|access_token|refresh_token|clientSecret|oauthState)"/.test(all));
});

test('toutes les routes de données exigent une session ; refresh exige aussi l’origine', async () => {
  const ctx = await setup();
  for (const url of DATA_GET_ROUTES) assert.equal((await ctx.app.inject({ url })).statusCode, 401, url);
  for (const p of ['tiktok', 'instagram', 'linkedin']) {
    assert.equal((await ctx.app.inject({ method: 'POST', url: `/api/platforms/${p}/refresh`, headers: { origin: ORIGIN }, payload: {} })).statusCode, 401);
    assert.equal((await ctx.app.inject({ method: 'POST', url: `/api/platforms/${p}/refresh`, headers: { origin: 'https://evil.example.com' }, payload: {} })).statusCode, 403);
  }
  // un cookie falsifié n'ouvre rien
  assert.equal((await ctx.app.inject({ method: 'POST', url: '/api/platforms/tiktok/refresh', headers: { origin: ORIGIN, cookie: 'sd_session=forge' }, payload: {} })).statusCode, 401);
  // GET sur la route d'actualisation : refusé (aucune lecture déclenchée par un simple lien)
  assert.equal((await ctx.get('/api/platforms/tiktok/refresh')).statusCode, 404);
});
