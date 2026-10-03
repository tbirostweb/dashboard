// Stale-while-revalidate, paliers léger/lourd, fusion, compteurs d'appels, Server-Timing, maintenance essentielle.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeApp, login, stubProvider, FakeClock, fakeFetch } from './helpers.js';
import { mergeLight, applyHeavy } from '../src/merge.js';
import { CallMeter, parseMetaUsage, platformOfUrl, slowdownFactor } from '../src/meter.js';
import { ProviderError } from '../src/http.js';
import { tiktokRaw, instagramRaw, linkedinRaw, DAY } from './integration-fixtures.js';
import { isoDay } from '../src/util.js';

const tok = (clock, extra = {}) => ({ accessToken: 'tok-test', refreshToken: 'rft-test', expiresAt: clock.now() + 20 * DAY, ...extra });
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const IG_HEAVY_KEYS = ['views', 'shares', 'saves', 'reach', 'viewsCount', 'reposts', 'totalInteractions', 'profileVisits', 'follows', 'avgWatchTimeSeconds', 'totalWatchTimeSeconds', 'skipRate'];

/** Fournisseur Instagram simulé à deux paliers ; `gates` permet de suspendre une lecture. */
function twoTier(clock, { light, heavy } = {}) {
  const calls = { light: 0, heavy: 0 };
  const prov = stubProvider('instagram', async () => { calls.heavy++; if (heavy) await heavy(); return instagramRaw(clock.now()); }, {
    heavyPostKeys: IG_HEAVY_KEYS,
    fetchLight: async () => {
      calls.light++;
      if (light) await light();
      const r = instagramRaw(clock.now());
      return {
        partial: true, account: r.account, followers: 2100,
        posts: [
          { id: 'ig-3', platform: 'instagram', type: 'Reel', title: 'Nouveau', publishedAt: new Date(clock.now() - 3600_000).toISOString(), views: null, likes: 5, comments: 0, shares: null, saves: null, url: 'u', reach: null, viewsCount: null },
          { ...r.posts[0], likes: 150, views: null, shares: null, reach: null, viewsCount: null, saves: null, reposts: null, totalInteractions: null, profileVisits: null, follows: null, avgWatchTimeSeconds: null, totalWatchTimeSeconds: null, skipRate: null },
          { ...r.posts[1], likes: 11, views: null, shares: null }
        ],
        details: { profile: { followersCount: 2100 }, today: { windowHours: 24, asOf: new Date(clock.now()).toISOString(), views: 77, likes: 5 } }
      };
    }
  });
  prov.calls = Object.assign(prov.calls, calls);
  prov.tierCalls = calls;
  return prov;
}

async function setup({ providers, platforms = ['instagram'], env = {} } = {}) {
  const clock = new FakeClock();
  const ctx = makeApp({ providers: providers(clock), now: clock.now, env: { LINKEDIN_COMMUNITY_API: 'true', LINKEDIN_ORGANIZATION_ID: '1', ...env } });
  for (const p of platforms) await ctx.store.setToken(p, tok(clock));
  ctx.clock = clock;
  ctx.cookie = await login(ctx.app);
  ctx.get = (url) => ctx.app.inject({ url, headers: { cookie: ctx.cookie } });
  return ctx;
}

// ------------------------------------------------------------------------------------------ Fusion légère / lourde
test('fusion : le palier léger met à jour les compteurs sans écraser les champs du palier lourd', () => {
  const t = Date.parse('2026-10-01T10:00:00Z');
  const heavy = applyHeavy(null, instagramRaw(t));
  assert.equal(heavy.partial, false);
  const light = {
    partial: true, account: heavy.account, followers: 2100,
    posts: [
      { id: 'ig-1', likes: 150, comments: 22, views: null, reach: null, viewsCount: null, shares: null, saves: null, reposts: null, totalInteractions: null, profileVisits: null, follows: null, avgWatchTimeSeconds: null, totalWatchTimeSeconds: null, skipRate: null, publishedAt: heavy.posts[0].publishedAt, platform: 'instagram' },
      { id: 'ig-new', likes: 1, comments: 0, views: null, shares: null, publishedAt: new Date(t - 3600_000).toISOString(), platform: 'instagram' }
    ],
    dailyViews: { '2026-10-01': 12 },
    details: { profile: { followersCount: 2100, biography: null }, today: { views: 9 } }
  };
  const m = mergeLight(heavy, light, { heavyKeys: IG_HEAVY_KEYS });
  const p1 = m.posts.find((p) => p.id === 'ig-1');
  assert.equal(p1.likes, 150, 'compteur rafraîchi');
  assert.equal(p1.comments, 22);
  assert.equal(p1.reach, 2000, 'insight du palier lourd conservé');
  assert.equal(p1.viewsCount, 3500);
  assert.equal(p1.skipRate, 0.31);
  assert.equal(p1.views, 2000, 'portée héritée conservée');
  assert.equal(m.posts.find((p) => p.id === 'ig-new').views, 0, 'nouvelle publication : 0 en attendant le lourd (jamais null)');
  assert.ok(m.posts.some((p) => p.id === 'ig-2'), 'publication plus ancienne que la 1re page : conservée');
  assert.equal(m.followers, 2100);
  assert.equal(m.details.reels.skipRate, 0.31, 'détails lourds (reels) conservés');
  assert.equal(m.details.profile.biography, 'Bio', 'null du léger n\'écrase pas une valeur connue');
  assert.equal(m.details.profile.followersCount, 2100);
  assert.deepEqual(m.details.today, { views: 9 });
  assert.equal(m.dailyViews['2026-10-01'], 12);
  assert.deepEqual(m.comments, [], 'commentaires du lourd conservés');
  assert.equal(m.partial, false, 'un jeu déjà lourd reste complet');
  // publication supprimée côté plateforme (plus récente que le plus ancien du léger et absente) : retirée
  const older = { id: 'ig-2', likes: 11, comments: 1, publishedAt: heavy.posts[1].publishedAt, platform: 'instagram', views: null, shares: null };
  const m2 = mergeLight(m, { ...light, posts: [light.posts[1], older] }, { heavyKeys: IG_HEAVY_KEYS });
  assert.ok(!m2.posts.some((p) => p.id === 'ig-1'), 'absente de la 1re page alors qu\'elle est plus récente que la plus ancienne lue : supprimée');
  // un lourd ultérieur remplace tout mais garde les totaux 24 h
  const h2 = applyHeavy(m, instagramRaw(t));
  assert.deepEqual(h2.details.today, { views: 9 });
});

test('fusion : premier chargement (aucun lourd) -> jeu partiel', () => {
  const m = mergeLight(null, { account: {}, followers: 1, posts: [], details: {} });
  assert.equal(m.partial, true);
  assert.deepEqual(m.comments, []);
});

// ------------------------------------------------------------------------------------------ SWR
test('SWR : donnée périmée servie immédiatement avec stale + refreshing, relecture en fond, single-flight', async () => {
  let prov;
  const gate = deferred();
  const ctx = await setup({ providers: (clock) => ({ instagram: (prov = twoTier(clock)), tiktok: stubProvider('tiktok', () => tiktokRaw(clock.now())), linkedin: stubProvider('linkedin', () => linkedinRaw(clock.now())) }) });
  const first = (await ctx.get('/api/platforms/instagram/stats')).json();
  await ctx.service.settle();
  assert.equal(first.stale, false);
  const fetches = prov.tierCalls.light + prov.tierCalls.heavy;
  ctx.clock.t += 16 * 60_000; // TTL de 15 min dépassé
  prov.tierCalls.light = prov.tierCalls.heavy = 0;
  prov.fetchLight = async () => { prov.tierCalls.light++; await gate.promise; const r = instagramRaw(ctx.clock.now()); return { partial: true, account: r.account, followers: 2222, posts: r.posts, details: {} }; };
  prov.fetchData = async () => ({ ...instagramRaw(ctx.clock.now()), followers: 2222 });
  ctx.cookie = await login(ctx.app);
  const t0 = Date.now();
  const rs = await Promise.all([1, 2, 3, 4, 5].map(() => ctx.get('/api/platforms/instagram/stats')));
  assert.ok(Date.now() - t0 < 1000, 'aucune attente du fournisseur bloqué');
  for (const r of rs) {
    const b = r.json();
    assert.equal(r.statusCode, 200);
    assert.equal(b.stale, true);
    assert.equal(b.refreshing, true);
    assert.equal(b.kpis.followers.value, 2000, 'ancienne valeur servie');
    assert.ok(b.updatedAt);
  }
  assert.equal(prov.tierCalls.light, 1, 'single-flight : une seule relecture pour 5 requêtes');
  gate.resolve();
  await ctx.service.settle();
  const after = (await ctx.get('/api/platforms/instagram/stats')).json();
  assert.equal(after.stale, false);
  assert.equal(after.refreshing, false);
  assert.equal(after.kpis.followers.value, 2222);
  assert.ok(Date.parse(after.updatedAt) > Date.parse(first.updatedAt));
  assert.ok(fetches >= 1);
});

test('SWR : premier chargement sans cache = réponse partielle rapide (palier léger) + loading, lourd en arrière-plan', async () => {
  const heavyGate = deferred();
  let prov;
  const ctx = await setup({ providers: (clock) => ({ instagram: (prov = twoTier(clock, { heavy: () => heavyGate.promise })), tiktok: stubProvider('tiktok', () => tiktokRaw(clock.now())), linkedin: stubProvider('linkedin', () => linkedinRaw(clock.now())) }) });
  const r = await ctx.get('/api/platforms/instagram/stats');
  assert.equal(r.statusCode, 200);
  const b = r.json();
  assert.deepEqual(b.loading, ['post_insights', 'comments', 'audience']);
  assert.equal(b.refreshing, true);
  assert.equal(b.heavyUpdatedAt, null);
  assert.equal(b.postsCount, 3);
  assert.equal(b.kpis.followers.value, 2100);
  const ov = (await ctx.get('/api/overview')).json();
  assert.ok(ov.loading.includes('instagram:comments'));
  assert.equal(ov.refreshing, true);
  const posts = await ctx.get('/api/posts?platform=instagram');
  assert.equal(posts.headers['x-data-loading'], 'instagram:post_insights,instagram:comments,instagram:audience');
  assert.equal(posts.headers['x-data-refreshing'], 'true');
  const comments = (await ctx.get('/api/comments')).json();
  assert.ok(comments.unavailable.some((u) => u.platform === 'instagram' && /chargement/.test(u.reason)));
  assert.equal(prov.tierCalls.heavy, 1, 'un seul palier lourd, même avec plusieurs requêtes');
  heavyGate.resolve();
  await ctx.service.settle();
  const done = (await ctx.get('/api/platforms/instagram/stats')).json();
  assert.deepEqual(done.loading, []);
  assert.ok(done.heavyUpdatedAt);
  assert.equal(done.refreshing, false);
});

test('SWR : erreur de revalidation (réseau/429) -> donnée périmée conservée, aucune erreur HTTP, refreshError exposé', async () => {
  let prov;
  const ctx = await setup({ providers: (clock) => ({ instagram: (prov = twoTier(clock)), tiktok: stubProvider('tiktok', () => tiktokRaw(clock.now())), linkedin: stubProvider('linkedin', () => linkedinRaw(clock.now())) }) });
  await ctx.get('/api/platforms/instagram/stats');
  await ctx.service.settle();
  ctx.clock.t += 20 * 60_000;
  ctx.cookie = await login(ctx.app);
  prov.fetchLight = async () => { throw new ProviderError('instagram', 'network', 'Plateforme injoignable'); };
  prov.fetchData = async () => { throw new ProviderError('instagram', 'network', 'Plateforme injoignable'); };
  const stale = await ctx.get('/api/platforms/instagram/stats');
  assert.equal(stale.statusCode, 200);
  await ctx.service.settle();
  const again = await ctx.get('/api/platforms/instagram/stats');
  assert.equal(again.statusCode, 200, 'donnée périmée plutôt qu\'une erreur');
  const b = again.json();
  assert.equal(b.stale, true);
  assert.equal(b.source.refreshError.code, 'network');
  assert.equal(b.kpis.followers.value, 2000);
});

test('SWR : jeton rejeté (auth) pendant la revalidation -> statut expired, plus de donnée servie', async () => {
  let prov;
  const ctx = await setup({ providers: (clock) => ({ instagram: (prov = twoTier(clock)), tiktok: stubProvider('tiktok', () => tiktokRaw(clock.now())), linkedin: stubProvider('linkedin', () => linkedinRaw(clock.now())) }) });
  await ctx.get('/api/platforms/instagram/stats');
  await ctx.service.settle();
  ctx.clock.t += 20 * 60_000;
  ctx.cookie = await login(ctx.app);
  prov.fetchLight = prov.fetchData = async () => { throw new ProviderError('instagram', 'auth', 'Jeton invalide'); };
  await ctx.get('/api/platforms/instagram/stats');
  await ctx.service.settle();
  const r = await ctx.get('/api/platforms/instagram/stats');
  assert.equal(r.statusCode, 409);
  assert.equal(r.json().error, 'token_expired');
});

test('SWR insights : périmé servi immédiatement avec updatedAt/stale/refreshing, relecture en fond', async () => {
  let n = 0;
  const gate = deferred();
  let blocking = false;
  const ctx = await setup({ providers: (clock) => ({
    instagram: stubProvider('instagram', () => instagramRaw(clock.now()), { fetchInsights: async (_t, { period }) => { n++; if (blocking) await gate.promise; return { generatedAt: new Date(clock.now()).toISOString(), views: { total: { value: 100 * n, previous: 1 } }, errors: {}, notes: [], period } } }),
    tiktok: stubProvider('tiktok', () => tiktokRaw(clock.now())), linkedin: stubProvider('linkedin', () => linkedinRaw(clock.now()))
  }) });
  const first = (await ctx.get('/api/platforms/instagram/insights?period=30')).json();
  assert.equal(first.views.total.value, 100);
  assert.equal(first.stale, false);
  assert.ok(first.updatedAt);
  assert.equal((await ctx.get('/api/platforms/instagram/insights?period=30')).json().views.total.value, 100);
  assert.equal(n, 1, 'cache TTL');
  ctx.clock.t += 16 * 60_000;
  ctx.cookie = await login(ctx.app);
  blocking = true;
  const rs = await Promise.all([ctx.get('/api/platforms/instagram/insights?period=30'), ctx.get('/api/platforms/instagram/insights?period=30')]);
  for (const r of rs) { const b = r.json(); assert.equal(b.stale, true); assert.equal(b.refreshing, true); assert.equal(b.views.total.value, 100); }
  assert.equal(n, 2, 'single-flight');
  gate.resolve();
  await ctx.service.settle();
  const fresh = (await ctx.get('/api/platforms/instagram/insights?period=30')).json();
  assert.equal(fresh.views.total.value, 200);
  assert.equal(fresh.stale, false);
});

// ------------------------------------------------------------------------------------------ Server-Timing, statut, compteurs
test('Server-Timing sur les routes de données (étapes, sans secret) ; absent des routes publiques', async () => {
  const ctx = await setup({ providers: (clock) => ({ instagram: twoTier(clock), tiktok: stubProvider('tiktok', () => tiktokRaw(clock.now())), linkedin: stubProvider('linkedin', () => linkedinRaw(clock.now())) }) });
  for (const url of ['/api/overview', '/api/platforms/instagram/stats', '/api/posts', '/api/comments', '/api/status']) {
    const r = await ctx.get(url);
    const h = r.headers['server-timing'];
    assert.match(h, /auth;dur=\d+(\.\d+)?/, url);
    assert.match(h, /total;dur=\d+(\.\d+)?/, url);
    assert.ok(/dataset;dur=|status;dur=/.test(h), url);
    assert.ok(!/tok-test|rft-test|cookie|sd_session/i.test(h));
  }
  assert.equal((await ctx.app.inject({ url: '/api/health' })).headers['server-timing'], undefined);
});

test('/api/status : updatedAt, heavyUpdatedAt, stale, refreshing, callsLastHour, quota (sans secret) et bloc live', async () => {
  const ctx = await setup({ platforms: ['instagram', 'tiktok', 'linkedin'], providers: (clock) => ({ instagram: twoTier(clock), tiktok: stubProvider('tiktok', () => tiktokRaw(clock.now())), linkedin: stubProvider('linkedin', () => linkedinRaw(clock.now())) }) });
  await ctx.get('/api/overview');
  await ctx.service.settle();
  ctx.meter.record('instagram', 7); ctx.meter.record('tiktok', 3); ctx.meter.record('linkedin', 12);
  ctx.meter.observeUsage('instagram', 42);
  const s = (await ctx.get('/api/status')).json();
  assert.equal(s.platforms.instagram.callsLastHour, 7);
  assert.equal(s.platforms.tiktok.callsLastHour, 3);
  assert.equal(s.platforms.linkedin.callsLastHour, 12);
  assert.deepEqual(Object.keys(s.platforms.instagram.quota).sort(), ['kind', 'note', 'slowdownFactor', 'usagePercent']);
  assert.equal(s.platforms.instagram.quota.usagePercent, 42);
  assert.equal(s.platforms.tiktok.quota.limitPerMinute, 600);
  assert.equal(s.platforms.linkedin.quota.kind, 'daily_budget');
  assert.equal(s.platforms.linkedin.quota.limit, 80);
  assert.ok(s.platforms.instagram.updatedAt && s.platforms.instagram.heavyUpdatedAt);
  assert.equal(s.platforms.instagram.stale, false);
  assert.equal(s.platforms.instagram.refreshing, false);
  assert.deepEqual(s.platforms.instagram.loading, []);
  assert.equal(s.live.enabled, true);
  assert.equal(s.live.active, true);
  assert.equal(s.live.intervals.instagram.lightSeconds, 60);
  assert.ok(!/tok-test|rft-test/.test(JSON.stringify(s)));
  // l'historique de calls glisse : au-delà d'1 h les compteurs retombent
  ctx.clock.t += 61 * 60_000;
  assert.equal(ctx.meter.callsLastHour('instagram'), 0);
});

test('compteur d\'appels : fetch enrobé, plateforme déduite de l\'hôte, en-têtes de quota Meta lus', async () => {
  const clock = new FakeClock();
  const meter = new CallMeter({ now: clock.now });
  const inner = fakeFetch([
    [/graph\.instagram\.com/, () => ({ json: {}, headers: { 'x-app-usage': '{"call_count":80,"total_time":20,"total_cputime":10}' } })],
    [/open\.tiktokapis\.com/, () => ({ json: {} })],
    [/dokploy\.example/, () => ({ json: {} })]
  ]);
  const f = meter.wrap(inner);
  await f('https://graph.instagram.com/v23.0/me?access_token=SECRET');
  await f('https://graph.instagram.com/v23.0/me/media');
  await f('https://open.tiktokapis.com/v2/user/info/');
  await f('https://dokploy.example.test/api/project.all');
  assert.equal(meter.callsLastHour('instagram'), 2);
  assert.equal(meter.callsLastHour('tiktok'), 1);
  assert.equal(meter.callsLastHour('linkedin'), 0);
  assert.equal(meter.usagePercent('instagram'), 80);
  assert.equal(slowdownFactor(80), 2);
  assert.equal(slowdownFactor(95), 4);
  assert.equal(slowdownFactor(10), 1);
  assert.equal(slowdownFactor(null), 1);
  assert.equal(platformOfUrl('https://api.linkedin.com/rest/x'), 'linkedin');
  assert.equal(platformOfUrl('https://example.org'), null);
  assert.equal(parseMetaUsage(new Headers({ 'x-business-use-case-usage': '{"123":[{"type":"instagram","call_count":71,"total_time":3,"total_cputime":4}]}' })), 71);
  assert.equal(parseMetaUsage(new Headers()), null);
  assert.equal(parseMetaUsage(new Headers({ 'x-app-usage': 'pas du json' })), null);
  clock.t += 3_700_000;
  assert.equal(meter.usagePercent('instagram'), null, 'mesure ancienne ignorée');
});

// ------------------------------------------------------------------------------------------ LinkedIn : budget et cadence inchangés
test('LinkedIn : jamais de palier léger ; relue au TTL (12 h) seulement, périmée servie immédiatement', async () => {
  let n = 0;
  const ctx = await setup({ platforms: ['linkedin'], providers: (clock) => ({
    instagram: stubProvider('instagram', () => instagramRaw(clock.now())), tiktok: stubProvider('tiktok', () => tiktokRaw(clock.now())),
    linkedin: stubProvider('linkedin', () => { n++; return linkedinRaw(clock.now()); })
  }) });
  assert.equal(ctx.service.hasTier('linkedin'), false);
  await ctx.get('/api/platforms/linkedin/stats');
  ctx.clock.t += 11 * 3_600_000;
  ctx.cookie = await login(ctx.app);
  await ctx.get('/api/platforms/linkedin/stats');
  await ctx.service.settle();
  assert.equal(n, 1, 'dans le TTL de 12 h : aucune relecture');
  ctx.clock.t += 2 * 3_600_000; // 13 h
  ctx.cookie = await login(ctx.app);
  const r = await ctx.get('/api/platforms/linkedin/stats');
  assert.equal(r.json().stale, true);
  await ctx.service.settle();
  assert.equal(n, 2, 'une relecture en fond');
});

// ------------------------------------------------------------------------------------------ Maintenance essentielle (inactivité)
test('inactivité : seuls jeton + instantané quotidien (1 appel léger/plateforme/jour) ; aucun palier, historique conservé', async () => {
  const clock = new FakeClock();
  const log = { followers: 0, light: 0, heavy: 0, refresh: 0 };
  const mk = (id, raw, followers) => stubProvider(id, () => { log.heavy++; return raw(clock.now()); }, {
    fetchLight: async () => { log.light++; return {}; },
    fetchFollowers: async () => { log.followers++; return followers; },
    needsRefresh: () => true,
    refresh: async (t) => { log.refresh++; return { ...t, accessToken: 'tok-rotated', expiresAt: clock.now() + 20 * DAY }; }
  });
  const providers = { tiktok: mk('tiktok', tiktokRaw, 1234), instagram: mk('instagram', instagramRaw, 2345), linkedin: stubProvider('linkedin', () => { log.heavy++; return linkedinRaw(clock.now()); }) };
  const ctx = makeApp({ providers, now: clock.now, env: { LINKEDIN_COMMUNITY_API: 'true', LINKEDIN_ORGANIZATION_ID: '1' } });
  for (const p of ['tiktok', 'instagram']) await ctx.store.setToken(p, tok(clock));
  assert.equal(ctx.presence.active(), false);
  await ctx.service.refreshAll({ mode: 'essential' });
  const today = isoDay(clock.now());
  assert.equal((await ctx.store.getSnapshots('tiktok'))[today], 1234);
  assert.equal((await ctx.store.getSnapshots('instagram'))[today], 2345);
  assert.equal(log.followers, 2, 'un appel léger par plateforme');
  assert.equal(log.light + log.heavy, 0, 'aucun palier léger ou lourd en inactivité');
  assert.equal(log.refresh, 2, 'jetons rafraîchis');
  assert.equal((await ctx.store.getToken('tiktok')).accessToken, 'tok-rotated');
  await ctx.service.refreshAll({ mode: 'essential' });
  assert.equal(log.followers, 2, 'au plus un instantané par jour');
  // le lendemain : nouvel instantané, l'historique de la veille est conservé
  clock.t += DAY;
  for (const p of ['tiktok', 'instagram']) await ctx.store.setToken(p, tok(clock));
  await ctx.service.refreshAll({ mode: 'essential' });
  const snaps = await ctx.store.getSnapshots('tiktok');
  assert.equal(Object.keys(snaps).length, 2);
  assert.equal(snaps[today], 1234, 'historique conservé');
  assert.equal(log.followers, 4);
});

test('inactivité : LinkedIn = au plus une lecture budgétée par jour sans instantané, jamais de palier', async () => {
  const clock = new FakeClock();
  let n = 0;
  const providers = {
    tiktok: stubProvider('tiktok', () => tiktokRaw(clock.now())), instagram: stubProvider('instagram', () => instagramRaw(clock.now())),
    linkedin: stubProvider('linkedin', () => { n++; return linkedinRaw(clock.now()); })
  };
  const ctx = makeApp({ providers, now: clock.now, env: { LINKEDIN_COMMUNITY_API: 'true', LINKEDIN_ORGANIZATION_ID: '1' } });
  await ctx.store.setToken('linkedin', tok(clock));
  await ctx.service.refreshAll({ mode: 'essential' });
  assert.equal(n, 1);
  assert.equal((await ctx.store.getSnapshots('linkedin'))[isoDay(clock.now())], 300);
  clock.t += 2 * 3_600_000; // reste dans la même journée locale (10 h UTC de départ)
  await ctx.service.refreshAll({ mode: 'essential' });
  clock.t += 2 * 3_600_000;
  await ctx.service.refreshAll({ mode: 'essential' });
  assert.equal(n, 1, 'instantané du jour déjà pris : plus aucun appel');
});

test('refreshAll sans option : comportement historique inchangé (relecture complète)', async () => {
  const clock = new FakeClock();
  let n = 0;
  const providers = { tiktok: stubProvider('tiktok', () => { n++; return tiktokRaw(clock.now()); }), instagram: stubProvider('instagram', () => instagramRaw(clock.now())), linkedin: stubProvider('linkedin', () => linkedinRaw(clock.now())) };
  const ctx = makeApp({ providers, now: clock.now });
  await ctx.store.setToken('tiktok', tok(clock));
  await ctx.service.refreshAll();
  assert.equal(n, 1);
});
