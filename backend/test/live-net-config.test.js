// Configuration du mode en direct (bornes, planchers), transport keep-alive, paliers légers des connecteurs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { testConfig } from './helpers.js';
import { createKeepAliveFetch } from '../src/net.js';
import { createProviders } from '../src/providers/index.js';
import { platformRoutes, TT_ACCESS, IG_LONG } from './fixtures.js';
import { DAY } from './integration-fixtures.js';

test('config live : défauts sûrs', () => {
  const c = testConfig();
  assert.deepEqual(c.live, {
    enabled: true, activeWindowSeconds: 90,
    instagramLightSeconds: 60, instagramHeavySeconds: 900, tiktokLightSeconds: 90, tiktokHeavySeconds: 900,
    dokployMetricsTtlMs: 2000, dokployStatusTtlMs: 5000, dokployRunningTtlMs: 3000, rateLimitPerMinute: 90
  });
  assert.equal(c.persistCache, true);
  assert.equal(c.instagram.insightConcurrency, 5, 'défaut inchangé');
});

test('config live : valeurs hors bornes ramenées dans [min, max], planchers >= 15 s, valeurs invalides -> défaut', () => {
  const low = testConfig({
    LIVE_ACTIVE_WINDOW_SECONDS: '1', LIVE_INSTAGRAM_LIGHT_SECONDS: '1', LIVE_TIKTOK_LIGHT_SECONDS: '0',
    LIVE_INSTAGRAM_HEAVY_SECONDS: '5', LIVE_TIKTOK_HEAVY_SECONDS: '-4',
    LIVE_DOKPLOY_METRICS_TTL_MS: '1', LIVE_DOKPLOY_STATUS_TTL_MS: '0', LIVE_RATE_LIMIT_PER_MINUTE: '1'
  }).live;
  assert.equal(low.activeWindowSeconds, 30);
  assert.equal(low.instagramLightSeconds, 15, 'plancher 15 s : jamais plus rapide, même par erreur de configuration');
  assert.equal(low.tiktokLightSeconds, 15);
  assert.equal(low.instagramHeavySeconds, 60);
  assert.equal(low.tiktokHeavySeconds, 60);
  assert.equal(low.dokployMetricsTtlMs, 1000);
  assert.equal(low.dokployStatusTtlMs, 1000);
  assert.equal(low.rateLimitPerMinute, 30);
  const high = testConfig({ LIVE_ACTIVE_WINDOW_SECONDS: '99999', LIVE_INSTAGRAM_LIGHT_SECONDS: '999999', LIVE_RATE_LIMIT_PER_MINUTE: '99999', LIVE_DOKPLOY_METRICS_TTL_MS: '999999999' }).live;
  assert.equal(high.activeWindowSeconds, 900);
  assert.equal(high.instagramLightSeconds, 3600);
  assert.equal(high.rateLimitPerMinute, 600);
  assert.equal(high.dokployMetricsTtlMs, 60_000);
  const bad = testConfig({ LIVE_ACTIVE_WINDOW_SECONDS: 'abc', LIVE_INSTAGRAM_LIGHT_SECONDS: '', LIVE_TIKTOK_LIGHT_SECONDS: 'x' }).live;
  assert.equal(bad.activeWindowSeconds, 90);
  assert.equal(bad.instagramLightSeconds, 60);
  assert.equal(bad.tiktokLightSeconds, 90);
  // le lourd n'est jamais plus fréquent que le léger
  const inv = testConfig({ LIVE_INSTAGRAM_LIGHT_SECONDS: '600', LIVE_INSTAGRAM_HEAVY_SECONDS: '120' }).live;
  assert.equal(inv.instagramHeavySeconds, 600);
});

test('config live : LIVE_ENABLED et PERSIST_CACHE désactivables', () => {
  const c = testConfig({ LIVE_ENABLED: 'false', PERSIST_CACHE: '0' });
  assert.equal(c.live.enabled, false);
  assert.equal(c.persistCache, false);
});

test('transport keep-alive : connexions réutilisées entre requêtes séquentielles, pas de pipelining', async () => {
  let connections = 0;
  let maxConcurrentOnSocket = 0;
  const server = http.createServer((req, res) => {
    const s = req.socket;
    s.inflight = (s.inflight || 0) + 1;
    maxConcurrentOnSocket = Math.max(maxConcurrentOnSocket, s.inflight);
    setTimeout(() => { s.inflight--; res.setHeader('content-type', 'application/json'); res.end('{"ok":true}'); }, 5);
  });
  server.on('connection', () => { connections++; });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  const net = createKeepAliveFetch();
  try {
    for (let i = 0; i < 12; i++) {
      const res = await net.fetch(`http://127.0.0.1:${port}/x`);
      assert.deepEqual(await res.json(), { ok: true });
    }
    assert.ok(connections <= 2, `12 requêtes séquentielles réutilisent les connexions (${connections} ouvertes, pas 12)`);
    await Promise.all(Array.from({ length: 4 }, () => net.fetch(`http://127.0.0.1:${port}/y`).then((r) => r.text())));
    assert.ok(connections >= 2 && connections <= 6, `parallélisme par connexions multiples : ${connections}`);
    assert.equal(maxConcurrentOnSocket, 1, 'jamais deux requêtes en vol sur la même connexion (pipelining désactivé)');
  } finally {
    await net.close();
    await new Promise((r) => server.close(r));
  }
});

test('transport keep-alive : signal d\'annulation et erreurs réseau propagés comme avec fetch', async () => {
  const net = createKeepAliveFetch();
  try {
    await assert.rejects(net.fetch('http://127.0.0.1:1/', { signal: AbortSignal.timeout(500) }));
  } finally { await net.close(); }
});

// ------------------------------------------------------------------------------------------ Paliers légers des connecteurs
const NOW = Date.parse('2026-10-01T10:00:00Z');
const cfgTok = (extra = {}) => ({ accessToken: TT_ACCESS, expiresAt: NOW + DAY, ...extra });

test('TikTok palier léger : 2 appels (profil + 1re page), ni pagination ni miniatures, résultat partiel', async () => {
  const fetch = platformRoutes(NOW);
  const p = createProviders(testConfig({ TIKTOK_RETRY_DELAY_MS: '0' }), { fetch, now: () => NOW }).tiktok;
  const light = await p.fetchLight(cfgTok());
  assert.equal(fetch.calls.length, 2);
  assert.ok(fetch.calls.some((c) => /user\/info/.test(c.url)));
  assert.ok(fetch.calls.some((c) => /video\/list/.test(c.url)));
  assert.ok(!fetch.calls.some((c) => /video\/query/.test(c.url)), 'miniatures manquantes : palier lourd');
  assert.equal(light.partial, true);
  assert.equal(light.followers, 4200);
  assert.equal(light.posts.length, 2, 'vidéos hors fenêtre exclues');
  assert.equal(light.details.coverage, undefined, 'couverture/cadence : palier lourd');
  assert.equal(light.details.cadence, undefined);
  assert.equal(light.details.profile.followerCount, 4200);
  assert.deepEqual(p.heavyPostKeys, ['coverUrl']);
});

test('TikTok : fetchFollowers = 1 seul appel léger ; palier lourd inchangé (profil + vidéos + miniatures)', async () => {
  const fetch = platformRoutes(NOW);
  const p = createProviders(testConfig({ TIKTOK_RETRY_DELAY_MS: '0' }), { fetch, now: () => NOW }).tiktok;
  assert.equal(await p.fetchFollowers(cfgTok()), 4200);
  assert.equal(fetch.calls.length, 1);
  const heavy = await p.fetchData(cfgTok());
  assert.equal(heavy.partial, undefined);
  assert.ok(heavy.details.coverage && heavy.details.cadence);
});

test('Instagram palier léger : profil + médias récents + portée du jour en parallèle, aucun insight par média ni commentaire', async () => {
  const todayRoute = [(url) => /me\/insights\?metric=views%2Ctotal_interactions|me\/insights\?metric=views,total_interactions/.test(url), () => ({ json: { data: [
    { name: 'views', total_value: { value: 77 } }, { name: 'likes', total_value: { value: 5 } }, { name: 'comments', total_value: { value: 2 } }
  ] } })];
  const fetch = platformRoutes(NOW, { routes: [todayRoute] });
  const p = createProviders(testConfig(), { fetch, now: () => NOW }).instagram;
  const light = await p.fetchLight({ accessToken: IG_LONG, expiresAt: NOW + 30 * DAY });
  const urls = fetch.calls.map((c) => c.url.split('?')[0].replace(/^https:\/\/graph\.instagram\.com\/v[\d.]+\//, ''));
  assert.equal(fetch.calls.length, 4, `4 appels au plus : ${urls.join(', ')}`);
  assert.ok(!urls.some((u) => /\/insights$/.test(u) && !u.startsWith('me/')), 'aucun insight par média');
  assert.ok(!urls.some((u) => /comments/.test(u)), 'aucun commentaire');
  assert.equal(light.partial, true);
  assert.equal(light.followers, 1800);
  assert.equal(light.posts.length, 2);
  assert.equal(light.posts[0].views, null, 'portée par média : palier lourd');
  assert.equal(light.posts[0].likes, 80);
  assert.equal(light.details.today.views, 77);
  assert.equal(light.details.today.windowHours, 24);
  assert.equal(light.details.today.likes, 5);
  assert.equal(light.details.today.shares, null, 'métrique absente = null, jamais 0');
  assert.equal(light.dailyViews[Object.keys(light.dailyViews)[0]], 321);
  assert.equal(light.comments, undefined);
  assert.deepEqual(p.heavyPostKeys.slice(0, 3), ['views', 'shares', 'saves']);
});

test('Instagram : fetchFollowers = 1 seul appel ; insights du jour refusés -> ignorés sans casser le palier léger', async () => {
  const fetch = platformRoutes(NOW);
  const p = createProviders(testConfig(), { fetch, now: () => NOW }).instagram;
  assert.equal(await p.fetchFollowers({ accessToken: IG_LONG }), 1800);
  assert.equal(fetch.calls.length, 1);
  const light = await p.fetchLight({ accessToken: IG_LONG });
  assert.equal(light.details.today, null, 'route des totaux 24 h non disponible : null');
  assert.equal(light.posts.length, 2);
});

test('palier léger : une erreur d\'authentification est propagée (jeton rejeté)', async () => {
  const fetch = platformRoutes(NOW, { routes: [[/graph\.instagram\.com\/v[\d.]+\/me\?fields=/, () => ({ status: 401, json: { error: { message: 'Invalid OAuth access token', code: 190 } } })]] });
  const p = createProviders(testConfig(), { fetch, now: () => NOW }).instagram;
  await assert.rejects(p.fetchLight({ accessToken: IG_LONG }), (e) => e.code === 'auth');
});
