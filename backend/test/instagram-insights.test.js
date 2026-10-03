// Insights du compte Instagram : normalisation, breakdowns, métrique en erreur, seuil d'audience, route API.
// Réponses Meta SIMULÉES (formes de https://developers.facebook.com/docs/instagram-platform/api-reference/instagram-user/insights).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fakeFetch, makeApp, login, testConfig } from './helpers.js';
import { platformRoutes, IG_LONG } from './fixtures.js';
import { readTotal, chunkRange, createInstagramProvider } from '../src/providers/instagram.js';
import { createMockSource } from '../src/mock.js';

const DAY = 86_400_000;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const tv = (name, value, breakdownKey, results) => ({
  name, period: 'day', title: name,
  total_value: breakdownKey
    ? { value, breakdowns: [{ dimension_keys: [breakdownKey], results: Object.entries(results).map(([k, v]) => ({ dimension_values: [k], value: v })) }] }
    : { value }
});

// Valeurs de la période courante (exemple des Insights de l'appli) ; la période précédente vaut la moitié.
const CUR = { views: 1782, total_interactions: 50, likes: 27, comments: 0, shares: 0, saves: 1, replies: 0, profile_links_taps: 6, reach: 895, accounts_engaged: 29 };

/** Faux Graph API Instagram pour /me/insights et l'audience. opts : followers, failMetrics, maxRangeDays, demoFail. */
function insightsFetch(now, { followers = 1800, failMetrics = ['reposts'], maxRangeDays = 30, engagedFail = true, authFail = false, period = 30, failBreakdowns = [] } = {}) {
  const nowS = Math.floor(now / 1000);
  const insightCalls = [];
  const route = (url) => {
    const u = new URL(url);
    const metrics = (u.searchParams.get('metric') || '').split(',');
    const breakdown = u.searchParams.get('breakdown');
    const since = Number(u.searchParams.get('since')), until = Number(u.searchParams.get('until'));
    insightCalls.push({ metrics, breakdown, since, until, timeframe: u.searchParams.get('timeframe') });
    if (authFail) return { status: 400, json: { error: { message: 'Error validating access token', type: 'OAuthException', code: 190 } } };

    // Démographie / online_followers
    if (metrics[0] === 'follower_demographics') {
      const res = {
        age: { '25-34': 700, '18-24': 300, '35-44': 500 },
        gender: { F: 1000, M: 780, U: 20 },
        country: { FR: 1500, BE: 120 },
        city: { 'Paris, Île-de-France': 600, 'Lyon, Auvergne-Rhône-Alpes': 200 }
      }[breakdown];
      return { json: { data: [tv('follower_demographics', undefined, breakdown, res)] } };
    }
    if (metrics[0] === 'engaged_audience_demographics') {
      return engagedFail ? { status: 400, json: { error: { message: 'Not enough engagement', code: 100 } } } : { json: { data: [tv('engaged_audience_demographics', undefined, breakdown, { F: 10 })] } };
    }
    if (metrics[0] === 'online_followers') {
      const hours = Object.fromEntries(Array.from({ length: 24 }, (_, h) => [String(h), h * 10]));
      return { json: { data: [{ name: 'online_followers', period: 'lifetime', values: [{ value: hours, end_time: '2026-09-29T07:00:00+0000' }, { value: {}, end_time: '2026-09-30T07:00:00+0000' }] }] } };
    }

    // Métriques jour : plage > maxRangeDays refusée
    if (until - since > maxRangeDays * 86400) return { status: 400, json: { error: { message: 'There cannot be more than 30 days between since and until', code: 100 } } };
    if (metrics.some((m) => failMetrics.includes(m))) return { status: 400, json: { error: { message: `(#100) metric[0] must be one of the following values`, code: 100 } } };
    const isPrev = since < nowS - period * 86400 - 5; // fenêtre précédente
    const chunkShare = (until - since) / (30 * 86400);              // les tranches se partagent les totaux de 30 j
    const k = (isPrev ? 0.5 : 1) * Math.min(1, chunkShare);
    const val = (m) => Math.round(CUR[m] * k);
    if (breakdown === 'follower_type') return { status: 400, json: { error: { message: '(#100) breakdown must be one of the following values: follow_type, ...', code: 100 } } };
    if (failBreakdowns.includes(breakdown)) return { status: 400, json: { error: { message: '(#100) breakdown not supported for this metric', code: 100 } } };
    const data = metrics.map((m) => {
      if (breakdown === 'follow_type' && m === 'views') return tv(m, val('views'), breakdown, { FOLLOWER: Math.round(85 * k), NON_FOLLOWER: Math.round(1697 * k) });
      if (breakdown === 'follow_type' && m === 'follows_and_unfollows') return tv(m, 0, breakdown, { FOLLOWER: Math.round(12 * k), NON_FOLLOWER: Math.round(3 * k) });
      if (breakdown === 'follow_type' && m === 'reach') return tv(m, val('reach'), breakdown, { FOLLOWER: Math.round(100 * k), NON_FOLLOWER: Math.round(795 * k) });
      if (breakdown === 'contact_button_type') return tv(m, val('profile_links_taps'), breakdown, { DIRECTION: Math.round(4 * k), CALL: Math.round(2 * k) });
      if (breakdown === 'media_product_type') return tv(m, val('views'), breakdown, { REEL: Math.round(1200 * k), POST: Math.round(582 * k) });
      return tv(m, val(m));
    });
    return { json: { data } };
  };
  const f = fakeFetch([
    [/graph\.instagram\.com\/v[\d.]+\/me\?fields=followers_count/, () => ({ json: { followers_count: followers, id: '1789' } })],
    [/graph\.instagram\.com\/v[\d.]+\/me\/insights\?/, route]
  ]);
  f.insightCalls = insightCalls;
  return f;
}

const provider = (fetch, now) => createInstagramProvider(testConfig(), { fetch, now: () => now });
const TOKEN = { accessToken: IG_LONG, expiresAt: Date.now() + 30 * DAY };

test('readTotal / chunkRange : total_value, breakdowns, tranches de 30 j', () => {
  assert.deepEqual(readTotal(tv('views', 10, 'follower_type', { FOLLOWER: 3, NON_FOLLOWER: 7 })), { value: 10, breakdown: { FOLLOWER: 3, NON_FOLLOWER: 7 } });
  assert.deepEqual(readTotal({ name: 'x', values: [{ value: 2 }, { value: 3 }] }), { value: 5, breakdown: null });
  assert.equal(readTotal(undefined), null);
  assert.deepEqual(chunkRange(0, 90 * 86400).length, 3);
  assert.deepEqual(chunkRange(0, 7 * 86400), [[0, 7 * 86400]]);
});

test('Insights Instagram 30 j : normalisation, follower_type / follow_type / contact_button_type, variation', async () => {
  const now = Date.now();
  const fetch = insightsFetch(now);
  const ins = await provider(fetch, now).fetchInsights(TOKEN, { period: 30 });

  assert.deepEqual(ins.views.total, { value: 1782, previous: 891 });
  assert.equal(ins.views.followers.value, 85);
  assert.equal(ins.views.nonFollowers.value, 1697);
  assert.equal((ins.views.followers.value / ins.views.total.value * 100).toFixed(1), '4.8');
  assert.deepEqual(ins.views.viewers, { value: 895, previous: 448 });
  assert.equal(ins.views.viewersFollowers.value, 100);
  assert.deepEqual(ins.views.byContentType.map((x) => [x.key, x.label, x.value]), [['REEL', 'Reels', 1200], ['POST', 'Publications', 582]]);

  const it = ins.interactions;
  assert.deepEqual([it.total.value, it.likes.value, it.saves.value, it.comments.value, it.shares.value, it.engagedAccounts.value], [50, 27, 1, 0, 0, 29]);

  const pr = ins.profile;
  assert.equal(pr.linkTaps.value, 6);
  assert.equal(pr.addressTaps.value, 4);
  assert.deepEqual(pr.byButton.map((x) => x.label), ["Adresse de l'entreprise", 'Appeler']);
  assert.deepEqual([pr.follows.value, pr.unfollows.value, pr.netFollowers.value], [12, 3, 9]);
  assert.equal(pr.netFollowers.previous, 6 - 2);

  // Les métriques supprimées par Meta ne sont jamais demandées
  const asked = new Set(fetch.insightCalls.flatMap((c) => c.metrics));
  ['impressions', 'profile_views', 'website_clicks', 'email_contacts', 'get_directions_clicks'].forEach((m) => assert.ok(!asked.has(m), m));
  fetch.insightCalls.filter((c) => !c.timeframe && c.metrics[0] !== 'online_followers').forEach((c) => assert.ok(c.until - c.since <= 30 * 86400));
});

test('Une métrique en erreur est omise sans casser les autres (reposts refusé)', async () => {
  const now = Date.now();
  const ins = await provider(insightsFetch(now, { failMetrics: ['reposts', 'comments'], period: 7 }), now).fetchInsights(TOKEN, { period: 7 });
  assert.equal(ins.interactions.reposts, null);
  assert.equal(ins.interactions.comments, null);
  assert.equal(ins.interactions.likes.value, Math.round(27 * 7 / 30));
  assert.ok(ins.errors.reposts && ins.errors.comments);
  assert.match(ins.notes[0], /reposts/);
  assert.ok(!JSON.stringify(ins).includes(IG_LONG), 'aucun token dans la sortie');
});

test('Insights 90 j : métriques additives sommées par tranches de 30 j, comptes uniques omis', async () => {
  const now = Date.now();
  const fetch = insightsFetch(now, { period: 90 });
  const ins = await provider(fetch, now).fetchInsights(TOKEN, { period: 90 });
  assert.equal(ins.views.total.value, 1782 * 3);
  assert.equal(ins.views.followers.value, 85 * 3);
  assert.equal(ins.views.viewers, null, 'reach non additionnable : omis');
  assert.equal(ins.interactions.engagedAccounts, null);
  assert.ok(ins.notes.some((n) => /90 jours/.test(n)));
  assert.equal(ins.profile.netFollowers.value, 27);
});

test('Audience : démographie des followers (âge trié, genres, pays, villes), heures d’activité, audience engagée refusée', async () => {
  const now = Date.now();
  const fetch = insightsFetch(now);
  const a = (await provider(fetch, now).fetchInsights(TOKEN, { period: 30 })).audience;
  assert.equal(a.status, 'ok');
  assert.deepEqual(a.followers.age.map((x) => x.key), ['18-24', '25-34', '35-44']);
  assert.deepEqual(a.followers.gender.map((x) => x.label), ['Femmes', 'Hommes', 'Non précisé']);
  assert.deepEqual(a.followers.country[0], { key: 'FR', label: 'FR', value: 1500 });
  assert.equal(a.followers.city[0].label, 'Paris, Île-de-France');
  assert.equal(a.followers.timeframe, 'this_month');
  assert.equal(a.engaged, null, 'engaged_audience_demographics refusé → omis');
  assert.equal(a.onlineHours.length, 24);
  assert.equal(a.onlineHours[23], 230, 'jours vides ignorés dans la moyenne');
  const engagedCall = fetch.insightCalls.find((c) => c.metrics[0] === 'engaged_audience_demographics');
  assert.equal(engagedCall.timeframe, 'last_30_days');
});

test('Audience sous le seuil de 100 followers : aucun appel démographique, statut below_threshold', async () => {
  const now = Date.now();
  const fetch = insightsFetch(now, { followers: 42, period: 7 });
  const a = (await provider(fetch, now).fetchInsights(TOKEN, { period: 7 })).audience;
  assert.deepEqual([a.status, a.threshold, a.followersCount], ['below_threshold', 100, 42]);
  assert.ok(!fetch.insightCalls.some((c) => /demographics|online_followers/.test(c.metrics[0])));
});

test('Token invalide (code 190) : erreur auth propagée', async () => {
  const now = Date.now();
  await assert.rejects(() => provider(insightsFetch(now, { authFail: true }), now).fetchInsights(TOKEN, { period: 7 }), (e) => e.code === 'auth');
});

test('Démo (data/mock.js) : mêmes formes que le connecteur réel', async () => {
  const now = Date.now();
  const real = await provider(insightsFetch(now, { engagedFail: false }), now).fetchInsights(TOKEN, { period: 30 });
  const mock = createMockSource(path.join(root, 'data/mock.js')).get().insights.instagram;
  for (const P of [7, 30, 90]) {
    const m = mock.byPeriod[P];
    for (const s of ['views', 'interactions', 'profile']) assert.deepEqual(Object.keys(m[s]).sort(), Object.keys(real[s]).sort(), `${s} ${P}`);
  }
  assert.equal(mock.byPeriod[90].views.viewers, null, 'démo : pas de comptes uniques sur 90 j, comme l’API');
  assert.deepEqual(Object.keys(mock.audience).sort(), Object.keys(real.audience).sort());
  assert.deepEqual(Object.keys(mock.audience.followers).sort(), Object.keys(real.audience.followers).sort());
});

test('Route /api/platforms/instagram/insights : démo, non connecté, plateforme non prise en charge', async () => {
  const demo = makeApp({ env: { MOCK_FALLBACK: 'true' } });
  let cookie = await login(demo.app);
  const r = await demo.app.inject({ url: '/api/platforms/instagram/insights?period=7', headers: { cookie } });
  assert.equal(r.statusCode, 409);
  assert.equal(r.json().error, 'not_connected');
  assert.equal((await demo.app.inject({ url: '/api/platforms/tiktok/insights', headers: { cookie } })).statusCode, 404);
  assert.equal((await demo.app.inject({ url: '/api/platforms/linkedin/insights', headers: { cookie } })).statusCode, 404);

  const off = makeApp({ env: { MOCK_FALLBACK: 'false' } });
  cookie = await login(off.app);
  const r2 = await off.app.inject({ url: '/api/platforms/instagram/insights?period=30', headers: { cookie } });
  assert.equal(r2.statusCode, 409);
  assert.equal(r2.json().error, 'not_connected');
  assert.ok(!r2.body.includes('views'), 'aucune donnée fictive');
  assert.equal((await off.app.inject({ url: '/api/platforms/instagram/insights' })).statusCode, 401);
});

test('Route connectée : insights réels + série quotidienne, cache TTL par période', async () => {
  const now = Date.now();
  const ins = insightsFetch(now);
  const base = platformRoutes(now);
  const fetch = async (url, init) => (/\/me\/insights\?metric=(?!reach&period=day|follower_count)|me\?fields=followers_count/.test(url) ? ins(url, init) : base(url, init));
  const { app, store, service } = makeApp({ fetch, now: () => now, env: { MOCK_FALLBACK: 'false' } });
  await store.setToken('instagram', { accessToken: IG_LONG, refreshToken: null, expiresAt: now + 30 * DAY, obtainedAt: now });
  const cookie = await login(app);
  await app.inject({ url: '/api/platforms/instagram/stats', headers: { cookie } }); // démarrage à froid : léger puis lourd en fond
  await service.settle(); // palier lourd terminé : les insights se lisent normalement
  const r = await app.inject({ url: '/api/platforms/instagram/insights?period=30', headers: { cookie } });
  assert.equal(r.statusCode, 200);
  const b = r.json();
  assert.equal(b.source.status, 'connected');
  assert.equal(b.views.total.value, 1782);
  assert.equal(b.series.dates.length, 30);
  assert.ok(!r.body.includes(IG_LONG));
  const n = ins.insightCalls.length;
  await app.inject({ url: '/api/platforms/instagram/insights?period=30', headers: { cookie } });
  assert.equal(ins.insightCalls.length, n, 'servi depuis le cache');
  await app.inject({ url: '/api/platforms/instagram/insights?period=7', headers: { cookie } });
  assert.ok(ins.insightCalls.length > n, 'autre période = autre entrée de cache');
});

test('Breakdown follow_type accepté pour views ; follower_type n’est plus demandé', async () => {
  const now = Date.now();
  const fetch = insightsFetch(now);
  const ins = await provider(fetch, now).fetchInsights(TOKEN, { period: 30 });
  assert.equal(ins.views.followers.value, 85);
  assert.ok(!fetch.insightCalls.some((c) => c.breakdown === 'follower_type'));
  assert.ok(fetch.insightCalls.some((c) => c.metrics[0] === 'views' && c.breakdown === 'follow_type'));
  assert.ok(!ins.notes.some((n) => /views_by_follower/.test(n)));
});

test('Breakdown refusé : repli sans breakdown (total conservé) + note distincte', async () => {
  const now = Date.now();
  const ins = await provider(insightsFetch(now, { failBreakdowns: ['follow_type'] }), now).fetchInsights(TOKEN, { period: 30 });
  assert.equal(ins.views.total.value, 1782, 'total conservé');
  assert.equal(ins.views.followers, null);
  assert.equal(ins.views.nonFollowers, null);
  assert.equal(ins.views.viewersFollowers, null);
  assert.equal(ins.profile.follows, null);
  assert.ok(ins.notes.some((n) => /Découpage refusé/.test(n) && /views_by_follower/.test(n)));
  assert.ok(!ins.notes.some((n) => /Métriques refusées par Meta sur cette période/.test(n) && /views_by_follower/.test(n)));
  assert.ok(!ins.errors.views_by_follower);
});

test('Sous 100 abonnés : follows_and_unfollows non demandé, note, aucun jeton', async () => {
  const now = Date.now();
  const fetch = insightsFetch(now, { followers: 42, period: 7 });
  const ins = await provider(fetch, now).fetchInsights(TOKEN, { period: 7 });
  assert.ok(!fetch.insightCalls.some((c) => c.metrics.includes('follows_and_unfollows')));
  assert.equal(ins.profile.follows, null);
  assert.equal(ins.profile.netFollowers, null);
  assert.ok(ins.notes.some((n) => /100/.test(n)));
  assert.ok(!JSON.stringify(ins).includes(IG_LONG));
});
