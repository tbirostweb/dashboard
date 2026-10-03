import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeApp, login, testConfig } from './helpers.js';
import { platformRoutes, TT_ACCESS, LI_ACCESS } from './fixtures.js';
import { createMockSource } from '../src/mock.js';
import * as agg from '../src/aggregate.js';
import { createProviders } from '../src/providers/index.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const DAY = 86_400_000;

// Formes de référence : celles de data/mock.js
const mock = createMockSource(path.join(root, 'data/mock.js')).get();
const POST_KEYS = Object.keys(mock.posts[0]).sort();
const COMMENT_KEYS = Object.keys(mock.comments[0]).sort();
const DAILY_KEYS = Object.keys(mock.daily.tiktok[0]).sort();
const ACCOUNT_KEYS = Object.keys(mock.accounts.tiktok).sort();
const SECRET_KEY = /token|secret|password|authorization|cookie|refresh|api[_-]?key/i;

/**
 * Forme d'une publication normalisée : les clés de base (celles de mock.js) sont obligatoires ; les clés propres
 * à une plateforme sont autorisées (leur contenu est vérifié dans les tests de chaque fournisseur et d'intégration).
 * Contrôles conservés : aucune clé de type secret/jeton, types des champs de base, métriques numériques ou null.
 */
function assertPostShape(post) {
  const keys = Object.keys(post);
  POST_KEYS.forEach((k) => assert.ok(keys.includes(k), `clé de base manquante : ${k}`));
  keys.forEach((k) => assert.ok(!SECRET_KEY.test(k), `clé suspecte dans une publication : ${k}`));
  ['id', 'platform', 'type', 'title', 'publishedAt'].forEach((k) => assert.equal(typeof post[k], 'string', k));
  ['views', 'likes', 'comments', 'shares', 'saves'].forEach((k) => assert.ok(post[k] === null || Number.isFinite(post[k]), `${k} doit être un nombre ou null`));
  assert.ok(!Number.isNaN(Date.parse(post.publishedAt)));
}

/** Exécute le js/api.js du front en mode mock dans un bac à sable pour comparer les résultats. */
function frontApi() {
  const window = { MOCK_DATA: mock, DASHBOARD_CONFIG: { mode: 'mock' } };
  const ctx = { window, setTimeout, clearTimeout, console, URLSearchParams, location: { pathname: '/', hash: '', search: '' } };
  ctx.globalThis = ctx;
  vm.runInNewContext(fs.readFileSync(path.join(root, 'js/api.js'), 'utf8'), ctx);
  return window.Api;
}
const plain = (x) => JSON.parse(JSON.stringify(x));

test('Agrégats : données observées, périodes et valeurs absentes explicites', () => {
  for (const period of [7,30,90]) {
    const overview = agg.overview(mock, period);
    assert.equal(overview.period, period);
    assert.equal(overview.series.dates.length, period);
    assert.ok(overview.kpis.followers.value > 0);
  }
});

test('Normalisation TikTok : même format que mock.js, commentaires non disponibles', async () => {
  const now = Date.now();
  const p = createProviders(testConfig(), { fetch: platformRoutes(now), now: () => now }).tiktok;
  const raw = await p.fetchData({ accessToken: TT_ACCESS, expiresAt: now + DAY });
  assert.deepEqual(Object.keys(raw.account).sort(), ACCOUNT_KEYS);
  assert.equal(raw.account.handle, '@studiotest');
  assert.equal(raw.followers, 4200);
  assert.equal(raw.posts.length, 2, 'vidéo trop ancienne exclue');
  raw.posts.forEach(assertPostShape);
  assert.equal(raw.posts[0].type, 'Vidéo courte');
  assert.equal(raw.posts[1].type, 'Vidéo longue');
  assert.equal(raw.posts[1].title, 'Description longue');
  assert.equal(raw.comments, null);
  assert.match(raw.notes[0], /Commentaires non disponibles pour TikTok/);
  const daily = agg.buildDaily(raw, {}, agg.lastDates(190, now));
  assert.equal(daily.length, 190);
  daily.forEach((d) => assert.deepEqual(Object.keys(d).sort(), DAILY_KEYS));
  assert.equal(daily.at(-1).followers, 4200);
});

test('Normalisation Instagram : posts, insights (dégradation), commentaires + sentiment', async () => {
  const now = Date.now();
  const p = createProviders(testConfig(), { fetch: platformRoutes(now), now: () => now }).instagram;
  const raw = await p.fetchData({ accessToken: 'IGAAx', expiresAt: now + 30 * DAY });
  assert.equal(raw.account.handle, '@studio.test');
  assert.equal(raw.followers, 1800);
  raw.posts.forEach(assertPostShape);
  const [reel, carousel] = raw.posts;
  assert.deepEqual([reel.type, reel.views, reel.saves, reel.shares, reel.likes, reel.title], ['Reel', 1500, 12, 7, 80, 'Nouveau reel ✨']);
  assert.deepEqual([carousel.type, carousel.views, carousel.saves, carousel.title], ['Carrousel', 600, 3, 'Carrousel']);
  assert.equal(raw.comments.length, 2);
  raw.comments.forEach((c) => { assert.deepEqual(Object.keys(c).sort(), COMMENT_KEYS); assert.ok(!Object.keys(c).some((k) => SECRET_KEY.test(k))); });
  assert.equal(raw.comments[0].sentiment, 'positive');
  assert.equal(raw.comments[1].sentiment, 'negative');
  assert.equal(raw.comments[0].postId, reel.id);
  assert.ok(raw.notes.some((n) => /followers indisponible/.test(n)));
  assert.equal(Object.values(raw.dailyViews)[0], 321);
});

test('Normalisation LinkedIn : bloqué avant approbation, puis mode Page', async () => {
  const now = Date.now();
  const fetch0 = platformRoutes(now);
  const pendingP = createProviders(testConfig(), { fetch: fetch0, now: () => now }).linkedin;
  assert.equal(pendingP.pendingApproval, true);
  await assert.rejects(() => pendingP.fetchData({ accessToken: LI_ACCESS, expiresAt: now + DAY }), (e) => e.code === 'pending_approval');
  assert.equal(fetch0.calls.length, 0, 'aucun appel LinkedIn avant approbation');

  const cfg = testConfig({ LINKEDIN_COMMUNITY_API: 'true', LINKEDIN_ORGANIZATION_ID: 'urn:li:organization:146243022' });
  assert.equal(cfg.linkedin.organizationId, '146243022');
  assert.equal(cfg.linkedin.scopes, 'r_organization_social rw_organization_admin');
  assert.equal(cfg.linkedin.apiVersion, '202609');
  const fetch = platformRoutes(now);
  const org = createProviders(cfg, { fetch, now: () => now }).linkedin;
  const r2 = await org.fetchData({ accessToken: LI_ACCESS, scope: cfg.linkedin.scopes, expiresAt: now + DAY });
  assert.equal(r2.account.name, 'Studio Test SAS');
  assert.equal(r2.account.url, 'https://www.linkedin.com/company/studio-test/');
  assert.equal(r2.followers, 777);
  r2.posts.forEach(assertPostShape);
  assert.deepEqual(r2.posts.map((x) => [x.type, x.views, x.likes]), [['Document', 3000, 90], ['Texte', 1000, 20]]);
  assert.equal(r2.comments.length, 1);
  assert.deepEqual(Object.keys(r2.comments[0]).sort(), COMMENT_KEYS);
  assert.ok(r2.notes.some((n) => /Gains de followers/.test(n)), '403 sur une sous-ressource : noté, pas de plantage');
  // Les requêtes REST portent bien les en-têtes de versionnement
  const restCall = fetch.calls.find((c) => c.url.includes('/rest/posts'));
  assert.equal(restCall.init.headers['Linkedin-Version'], '202609');
  assert.equal(restCall.init.headers['X-Restli-Protocol-Version'], '2.0.0');
  assert.match(restCall.url, /author=urn%3Ali%3Aorganization%3A146243022/);
});

test('Non connecté (sans MOCK_FALLBACK) : 409 par plateforme, vue d’ensemble à zéro mais au bon format', async () => {
  const { app } = makeApp({ env: { MOCK_FALLBACK: 'false' } });
  const cookie = await login(app);
  const st = await app.inject({ url: '/api/platforms/tiktok/stats?period=30', headers: { cookie } });
  assert.equal(st.statusCode, 409);
  assert.equal(st.json().error, 'not_connected');
  assert.equal(st.json().platform, 'tiktok');
  assert.equal((await app.inject({ url: '/api/posts?platform=linkedin', headers: { cookie } })).statusCode, 409);

  const ov = (await app.inject({ url: '/api/overview?period=7', headers: { cookie } })).json();
  assert.equal(ov.period, 7);
  assert.equal(ov.series.dates.length, 7);
  assert.equal(ov.kpis.followers.value, null);
  assert.deepEqual(Object.keys(ov.perPlatform).sort(), ['instagram', 'linkedin', 'tiktok']);
  assert.equal(ov.sources.tiktok.status, 'not_connected');

  const status = (await app.inject({ url: '/api/status', headers: { cookie } })).json();
  assert.equal(status.platforms.instagram.status, 'not_connected');
  assert.equal(status.platforms.instagram.configured, true);

  const cm = (await app.inject({ url: '/api/comments?period=30', headers: { cookie } })).json();
  assert.deepEqual(cm.stats, { total: 0, positive: 0, neutral: 0, negative: 0 });
});

test('MOCK_FALLBACK=true est ignoré : aucun chiffre de démonstration', async () => {
  const { app } = makeApp({ env: { MOCK_FALLBACK: 'true' } });
  const cookie = await login(app);
  const overview = (await app.inject({ url: '/api/overview', headers: { cookie } })).json();
  assert.equal(overview.kpis.followers.value, null);
  assert.equal(overview.sources.instagram.status, 'not_connected');
  assert.equal((await app.inject({ url: '/api/platforms/instagram/stats', headers: { cookie } })).statusCode, 409);
  assert.deepEqual(overview.topPosts, []);
});

test('Plateforme connectée + cache : un seul appel amont pendant le TTL, rappel après expiration', async () => {
  let t = Date.now();
  const fetch = platformRoutes(t);
  const { app, store, service } = makeApp({ fetch, now: () => t, env: { CACHE_TTL_SECONDS: '600', MOCK_FALLBACK: 'true' } });
  await store.setToken('tiktok', { accessToken: TT_ACCESS, refreshToken: 'rft.fake', expiresAt: t + 20 * 3_600_000, scope: 'video.list' });
  const cookie = await login(app);

  const r1 = await app.inject({ url: '/api/platforms/tiktok/stats?period=30', headers: { cookie } });
  assert.equal(r1.statusCode, 200);
  const s = r1.json();
  assert.equal(s.account.handle, '@studiotest');
  assert.equal(s.source.status, 'connected');
  assert.equal(s.postsCount, 2);
  assert.equal(s.kpis.followers.value, 4200);
  assert.ok(!r1.body.includes(TT_ACCESS));
  await service.settle(); // premier chargement : palier léger attendu, palier lourd complété en arrière-plan
  const base = fetch.hits.ttUser;
  assert.equal(base, 2, 'palier léger + palier lourd');

  await app.inject({ url: '/api/overview?period=30', headers: { cookie } });
  await app.inject({ url: '/api/posts?platform=tiktok', headers: { cookie } });
  assert.equal(fetch.hits.ttUser, base, 'servi depuis le cache');

  const cm = (await app.inject({ url: '/api/comments?period=30', headers: { cookie } })).json();
  const ttNote = cm.unavailable.find((u) => u.platform === 'tiktok');
  assert.match(ttNote.reason, /Commentaires non disponibles pour TikTok/);
  assert.ok(cm.items.every((c) => c.platform !== 'tiktok'));

  t += 601_000;
  await app.inject({ url: '/api/overview?period=30', headers: { cookie } });
  await service.settle(); // stale-while-revalidate : la relecture part en arrière-plan, la réponse n'est pas bloquée
  assert.equal(fetch.hits.ttUser, base + 1, 'rappel (palier léger) après expiration du TTL');
  // Instantané de followers enregistré
  assert.equal(Object.values(await store.getSnapshots('tiktok'))[0], 4200);

  // Token TikTok proche de l'expiration → refresh automatique (grant_type=refresh_token)
  t += 20 * 3_600_000;
  const cookie2 = await login(app); // la session (12 h) a expiré entre-temps
  assert.equal((await app.inject({ url: '/api/overview?period=30', headers: { cookie } })).statusCode, 401, 'session expirée refusée');
  await app.inject({ url: '/api/overview?period=30', headers: { cookie: cookie2 } });
  assert.equal((await store.getToken('tiktok')).accessToken, 'act.refreshed');
});

test('Erreur plateforme : 502 propre, cache négatif, token invalide → statut expired', async () => {
  const now = Date.now();
  let calls = 0;
  const fetch = platformRoutes(now, { routes: [[/open\.tiktokapis\.com\/v2\/user\/info\//, () => { calls++; return { status: 401, json: { error: { code: 'access_token_invalid', message: 'The access token is invalid' } } }; }]] });
  const { app, store } = makeApp({ fetch, now: () => now });
  await store.setToken('tiktok', { accessToken: TT_ACCESS, refreshToken: null, expiresAt: now + 3_600_000 * 5 });
  const cookie = await login(app);
  const r = await app.inject({ url: '/api/platforms/tiktok/stats', headers: { cookie } });
  assert.equal(r.statusCode, 409);
  assert.equal(r.json().error, 'token_expired');
  assert.ok(!r.body.includes(TT_ACCESS));
  await app.inject({ url: '/api/overview', headers: { cookie } });
  assert.equal(calls, 1, 'pas de rappel immédiat de la plateforme en erreur');
  const st = (await app.inject({ url: '/api/status', headers: { cookie } })).json();
  assert.equal(st.platforms.tiktok.status, 'expired');
  const ov = await app.inject({ url: '/api/overview', headers: { cookie } });
  assert.equal(ov.statusCode, 200, 'la vue d’ensemble reste disponible');
});

test('buildDaily : aucun historique non observé inventé', () => {
  const dates = agg.lastDates(5, Date.parse('2026-09-30T12:00:00'));
  const raw = { followers: 110, posts: [], dailyNewFollowers: { [dates[4]]: 4, [dates[3]]: 6 }, dailyViews: { [dates[2]]: 50 } };
  const d = agg.buildDaily(raw, { [dates[0]]: 90 }, dates);
  assert.deepEqual(d.map((x) => x.followers), [90, null, null, null, 110]);
  assert.equal(d[4].newFollowers, 4);
  assert.equal(d[2].views, 50);
});
