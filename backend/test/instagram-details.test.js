// Enrichissement Instagram : details (profil, reels, couverture), champs de post, replis tolérants, breakdown follow_type.
// Réponses Meta SIMULÉES, aucun réseau.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fakeFetch, testConfig } from './helpers.js';
import { IG_LONG } from './fixtures.js';
import { igGraph, DAY } from './fixtures-instagram.js';
import { createInstagramProvider, MS_PER_SECOND } from '../src/providers/instagram.js';

const TOKEN = { accessToken: IG_LONG, expiresAt: Date.now() + 30 * DAY };
const make = (fetch, now, cfgMut) => {
  const cfg = testConfig();
  if (cfgMut) Object.assign(cfg.instagram, cfgMut);
  return createInstagramProvider(cfg, { fetch, now: () => now });
};
const byId = (raw, id) => raw.posts.find((p) => p.id === `ig-${id}`);

test('MS_PER_SECOND : les durées Meta sont en millisecondes', () => assert.equal(MS_PER_SECOND, 1000));

test('fetchData : details.profile, champs de post enrichis, reels pondérés (ms → s)', async () => {
  const now = Date.now();
  const raw = await make(igGraph(now), now).fetchData(TOKEN);
  const d = raw.details;
  assert.deepEqual(d.profile, {
    username: 'studio.test', name: 'Studio Test', accountType: 'BUSINESS', biography: '<i>Bio</i> 🎬', website: 'https://example.test',
    profilePictureUrl: 'https://cdn.example.test/me.jpg?sig=zz', followersCount: 1800, followsCount: 321, mediaCount: 3, imageUrlsExpire: true
  });
  assert.equal(d.imageUrlsExpire, true);
  const r1 = byId(raw, 'r1');
  assert.equal(r1.productType, 'REELS');
  assert.equal(r1.reach, 800);
  assert.equal(r1.viewsCount, 1000);
  assert.equal(r1.views, 800, 'contrat existant : views = portée héritée');
  assert.equal(r1.saves, 12);
  assert.equal(r1.reposts, 3);
  assert.equal(r1.totalInteractions, 104);
  assert.equal(r1.avgWatchTimeSeconds, 10);
  assert.equal(r1.totalWatchTimeSeconds, 500);
  assert.equal(r1.skipRate, 40);
  assert.equal(r1.thumbnailUrl, 'https://cdn.example.test/t1.jpg?sig=abc');
  assert.equal(r1.url, 'https://www.instagram.com/reel/r1/');
  const f1 = byId(raw, 'f1');
  assert.equal(f1.productType, 'FEED');
  assert.equal(f1.thumbnailUrl, 'https://cdn.example.test/p1.jpg', 'image : media_url sert de miniature');
  assert.deepEqual([f1.profileVisits, f1.follows], [8, 2]);
  assert.deepEqual([f1.avgWatchTimeSeconds, f1.skipRate], [null, null]);
  // Reels : pondération par les vues (1000 et 3000)
  assert.equal(d.reels.count, 2);
  assert.equal(d.reels.avgWatchTimeSeconds, (10 * 1000 + 20 * 3000) / 4000);
  assert.equal(d.reels.skipRate, (40 * 1000 + 20 * 3000) / 4000);
  assert.equal(d.reels.totalWatchTimeSeconds, 2500);
  assert.deepEqual(d.notes, raw.notes.slice(0, d.notes.length));
});

test('Reels sans données : null et non 0', async () => {
  const now = Date.now();
  const raw = await make(igGraph(now, { rejectMetrics: ['ig_reels_avg_watch_time', 'ig_reels_video_view_total_time', 'reels_skip_rate'] }), now).fetchData(TOKEN);
  assert.deepEqual(raw.details.reels, { count: 0, avgWatchTimeSeconds: null, totalWatchTimeSeconds: null, skipRate: null });
  const r1 = byId(raw, 'r1');
  assert.equal(r1.avgWatchTimeSeconds, null);
  assert.equal(r1.skipRate, null);
  assert.ok(raw.notes.some((n) => /ig_reels_avg_watch_time/.test(n) && /refusées/.test(n)));
  assert.equal(r1.reach, 800, 'les autres métriques restent');
});

test('Données absentes : null, jamais 0 par défaut (hors contrat existant)', async () => {
  const now = Date.now();
  const raw = await make(igGraph(now, { noInsightsFor: ['f1'], refuseBio: true, refuseProfilePic: true, refuseMediaFields: ['reposts_count'] }), now).fetchData(TOKEN);
  const f1 = byId(raw, 'f1');
  for (const k of ['reach', 'viewsCount', 'saves', 'reposts', 'totalInteractions', 'profileVisits', 'follows', 'avgWatchTimeSeconds', 'skipRate']) assert.equal(f1[k], null, k);
  const p = raw.details.profile;
  assert.deepEqual([p.biography, p.website, p.profilePictureUrl, p.followsCount], [null, null, null, null]);
  assert.ok(raw.notes.some((n) => /Insights indisponibles pour 1/.test(n)));
});

test('Champs de compte facultatifs refusés : notes, appel principal intact', async () => {
  const now = Date.now();
  const raw = await make(igGraph(now, { refuseProfilePic: true, refuseBio: true }), now).fetchData(TOKEN);
  assert.equal(raw.account.handle, '@studio.test');
  assert.equal(raw.followers, 1800);
  assert.equal(raw.posts.length, 3);
  assert.ok(raw.notes.some((n) => /Photo de profil/.test(n)));
  assert.ok(raw.notes.some((n) => /Biographie/.test(n)));
});

test('Champs de média optionnels refusés : repli progressif, publications conservées', async () => {
  const now = Date.now();
  const g1 = igGraph(now, { refuseMediaFields: ['reposts_count'] });
  const raw1 = await make(g1, now).fetchData(TOKEN);
  assert.equal(raw1.posts.length, 3);
  assert.ok(raw1.notes.some((n) => /Compteurs de médias/.test(n)));
  assert.ok(byId(raw1, 'r1').thumbnailUrl, 'champs image conservés');
  assert.equal(g1.mediaCalls.length, 2);

  const g2 = igGraph(now, { refuseMediaFields: ['reposts_count', 'media_url'] });
  const raw2 = await make(g2, now).fetchData(TOKEN);
  assert.equal(raw2.posts.length, 3);
  assert.equal(byId(raw2, 'r1').thumbnailUrl, null);
  assert.equal(g2.mediaCalls.at(-1), 'id,caption,media_type,media_product_type,permalink,timestamp,like_count,comments_count');
});

test('Compteurs de médias de repli utilisés seulement si l’insight manque', async () => {
  const now = Date.now();
  const raw = await make(igGraph(now, { noInsightsFor: ['f1'] }), now).fetchData(TOKEN);
  const f1 = byId(raw, 'f1');
  assert.deepEqual([f1.reposts, f1.saves, f1.viewsCount], [4, 15, 1111]);
  assert.equal(byId(raw, 'r1').reposts, 3, 'insight prioritaire');
});

test('Métrique de publication refusée : omise avec note, jamais inventée', async () => {
  const now = Date.now();
  const g = igGraph(now, { rejectMetrics: ['profile_visits', 'follows', 'reposts'] });
  const raw = await make(g, now).fetchData(TOKEN);
  const f1 = byId(raw, 'f1');
  assert.equal(f1.profileVisits, null);
  assert.equal(f1.reach, 600);
  assert.ok(raw.notes.some((n) => /Métriques de publication refusées/.test(n) && /profile_visits/.test(n)));
  const asked = new Set(g.insightCalls.flatMap((c) => c.metrics));
  ['impressions', 'plays', 'video_views'].forEach((m) => assert.ok(!asked.has(m), m));
});

test('Couverture : coverage et truncated selon les plafonds', async () => {
  const now = Date.now();
  const raw = await make(igGraph(now), now).fetchData(TOKEN);
  assert.deepEqual(raw.details.coverage, { mediaFetched: 3, insightsFetchedFor: 3, commentsFetchedFor: 1, truncated: false, windowDays: 190 });
  const small = await make(igGraph(now), now, { insightMediaMax: 2, commentMediaMax: 0 }).fetchData(TOKEN);
  assert.deepEqual(small.details.coverage, { mediaFetched: 3, insightsFetchedFor: 2, commentsFetchedFor: 0, truncated: true, windowDays: 190 });
  assert.ok(small.notes.some((n) => /Couverture partielle/.test(n)));
});

test('Aucun jeton dans la sortie ; HTML et emoji de la légende préservés', async () => {
  const now = Date.now();
  const raw = await make(igGraph(now), now).fetchData(TOKEN);
  const s = JSON.stringify(raw);
  assert.ok(!s.includes(IG_LONG));
  assert.ok(!/access_token/.test(s));
  assert.equal(byId(raw, 'r1').title, 'Reel <b>gras</b> & "quotes" 😀');
  assert.equal(raw.comments[0].text, '<script>alert(1)</script> super 😍');
});

test('Sous 100 abonnés : pas de follower_count dans fetchData', async () => {
  const now = Date.now();
  const g = igGraph(now, { followers: 42 });
  const raw = await make(g, now).fetchData(TOKEN);
  assert.equal(raw.details.profile.followersCount, 42);
  assert.ok(!g.calls.some((c) => /metric=follower_count/.test(c.url)));
  assert.ok(raw.notes.some((n) => /100/.test(n)));
  assert.deepEqual(raw.dailyNewFollowers, {});
});

test('Inconnu côté profil : null (jamais 0)', async () => {
  const now = Date.now();
  const f = fakeFetch([
    [/me\?fields=profile_picture_url/, () => ({ json: {} })],
    [/me\?fields=biography/, () => ({ json: {} })],
    [/me\?fields=user_id/, () => ({ json: { username: 'x' } })],
    [/me\/media\?/, () => ({ json: { data: [] } })],
    [/me\/insights/, () => ({ status: 400, json: { error: { message: 'no', code: 100 } } })]
  ]);
  const raw = await make(f, now).fetchData(TOKEN);
  assert.equal(raw.followers, null);
  assert.deepEqual(raw.details.profile, {
    username: 'x', name: null, accountType: null, biography: null, website: null, profilePictureUrl: null,
    followersCount: null, followsCount: null, mediaCount: null, imageUrlsExpire: true
  });
  assert.equal(raw.details.coverage.mediaFetched, 0);
});
