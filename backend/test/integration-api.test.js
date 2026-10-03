// Intégration (hors réseau) : /stats, /posts, /overview, /status avec des fournisseurs simulés.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeApp, login, stubProvider } from './helpers.js';
import * as agg from '../src/aggregate.js';
import { DAY, CANARY, tiktokRaw, instagramRaw, linkedinRaw } from './integration-fixtures.js';

const T0 = Date.parse('2026-09-30T10:00:00Z');
const tok = (extra = {}) => ({ accessToken: CANARY.access, refreshToken: CANARY.refresh, expiresAt: T0 + 20 * DAY, ...extra });

async function setup({ platforms = ['tiktok', 'instagram'], now = () => T0, env = {}, linkedin } = {}) {
  const raws = { tiktok: tiktokRaw(T0), instagram: instagramRaw(T0), linkedin: linkedin || linkedinRaw(T0) };
  const providers = Object.fromEntries(['tiktok', 'instagram', 'linkedin'].map((p) => [p, stubProvider(p, () => raws[p])]));
  const ctx = makeApp({ providers, now, env: { LINKEDIN_COMMUNITY_API: 'true', LINKEDIN_ORGANIZATION_ID: '1', ...env } });
  for (const p of platforms) await ctx.store.setToken(p, tok());
  ctx.cookie = await login(ctx.app);
  ctx.providers = providers;
  ctx.get = (url) => ctx.app.inject({ url, headers: { cookie: ctx.cookie } });
  return ctx;
}

test('/stats TikTok : details projetés (allowlist), coverage, updatedAt réel, cacheTtlSeconds', async () => {
  let t = T0;
  const ctx = await setup({ platforms: ['tiktok'], now: () => t });
  const r = await ctx.get('/api/platforms/tiktok/stats?period=30');
  assert.equal(r.statusCode, 200);
  const s = r.json();
  assert.deepEqual(Object.keys(s.details).sort(), ['cadence', 'coverage', 'imageUrlsExpire', 'notes', 'profile']);
  assert.deepEqual(Object.keys(s.details.profile).sort(), ['avatarUrl', 'bio', 'displayName', 'followerCount', 'followingCount', 'isVerified', 'likesCount', 'profileDeepLink', 'username', 'videoCount']);
  assert.equal(s.details.profile.avatarUrl, 'https://p16-sign.tiktokcdn-us.com/avatar.jpeg?sig=1');
  assert.equal(s.details.profile.followerCount, 1000);
  assert.deepEqual(s.coverage, { postsFetched: 2, windowDays: 190, maxPages: 5, truncated: false });
  assert.equal(s.updatedAt, new Date(T0).toISOString());
  assert.equal(s.cacheTtlSeconds, 900);
  // updatedAt = récupération réelle : une lecture servie par le cache plus tard ne le change pas
  t += 5 * 60_000;
  const s2 = (await ctx.get('/api/platforms/tiktok/stats?period=30')).json();
  assert.equal(s2.updatedAt, new Date(T0).toISOString());
  assert.equal(ctx.providers.tiktok.calls.fetch, 1);
  // champs historiques conservés
  ['kpis', 'series', 'byType', 'byHour', 'account', 'postsCount', 'viewLabel', 'source'].forEach((k) => assert.ok(k in s, k));
  assert.match(s.engagementBasis, /vues/);
  for (const c of Object.values(CANARY)) assert.ok(!r.body.includes(c), `canari ${c} exposé`);
});

test('/stats Instagram : projection (URL d’image hors CDN -> null) ; LinkedIn : blocks, budget, facettes non résolues', async () => {
  const ctx = await setup({ platforms: ['instagram', 'linkedin'] });
  const ig = (await ctx.get('/api/platforms/instagram/stats')).json();
  assert.deepEqual(Object.keys(ig.details).sort(), ['coverage', 'imageUrlsExpire', 'notes', 'profile', 'reels']);
  assert.equal(ig.details.profile.profilePictureUrl, 'https://scontent.cdninstagram.com/p.jpg?sig=2');
  assert.deepEqual(ig.coverage, { postsFetched: 2, insightsFetchedFor: 1, commentsFetchedFor: 0, truncated: false, windowDays: 190 });
  assert.equal(ig.details.reels.skipRate, 0.31);

  const li = (await ctx.get('/api/platforms/linkedin/stats')).json();
  assert.deepEqual(Object.keys(li.details).sort(), ['blocks', 'budget', 'coverage', 'followers', 'notes', 'organization', 'pageStats', 'reactionLabels', 'reactionsByType', 'retention', 'sponsoredPosts']);
  assert.deepEqual(li.details.budget.limit, 80);
  assert.equal(li.details.blocks.comments.state, 'ok');
  assert.deepEqual(li.details.followers.facets.country, [{ key: 'urn:li:geo:101', count: 120 }], 'URN conservé tel quel, aucun libellé inventé');
  assert.equal(li.coverage.windowMonths, 12);
  assert.equal(li.cacheTtlSeconds, 43200);
  const all = JSON.stringify([ig, li]);
  for (const c of Object.values(CANARY)) assert.ok(!all.includes(c), `canari ${c} exposé`);
  assert.ok(!all.includes('secretState') && !all.includes('debugDump'));
});

test('/stats : 409 si non connecté, 404 plateforme inconnue', async () => {
  const ctx = await setup({ platforms: [] });
  assert.equal((await ctx.get('/api/platforms/tiktok/stats')).statusCode, 409);
  assert.equal((await ctx.get('/api/platforms/facebook/stats')).statusCode, 404);
});

test('/posts : champs par plateforme, imageUrl unique assaini, portée distincte des vues, null conservé, taux en %', async () => {
  const ctx = await setup({ platforms: ['tiktok', 'instagram', 'linkedin'] });
  const list = (await ctx.get('/api/posts?period=30')).json();
  const byId = Object.fromEntries(list.map((p) => [p.id, p]));

  const tt = byId['tt-1'];
  assert.equal(tt.imageUrl, 'https://p16-sign.tiktokcdn-eu.com/obj/cover1.jpeg?x-expires=1&sig=abc');
  assert.equal(tt.imageUrlsExpire, true);
  assert.equal(tt.saves, null);
  assert.equal(tt.interactions, 65);
  assert.equal(tt.engagementRate, 6.5);
  assert.equal(tt.durationBucket, '15–30 s');
  assert.equal(tt.durationSeconds, 20);
  assert.match(tt.engagementBasis, /vues/);
  assert.ok(!('coverUrl' in tt) && !('thumbnailUrl' in tt) && !('accessToken' in tt));
  assert.equal(byId['tt-2'], undefined, 'hors période de 30 j');

  const ig = byId['ig-1'];
  assert.equal(ig.imageUrl, 'https://scontent-cdg4-1.cdninstagram.com/v/t51/a.jpg?sig=1');
  assert.equal(ig.productType, 'REELS');
  assert.equal(ig.reach, 2000);
  assert.equal(ig.viewsCount, 3500, 'vraies vues distinctes de la portée');
  assert.equal(ig.views, 2000, 'views = portée héritée');
  assert.equal(ig.saves, 30);
  assert.equal(ig.interactions, 160);
  assert.equal(ig.engagementRate, 8);
  assert.match(ig.engagementBasis, /portée/);
  const ig2 = byId['ig-2'];
  assert.equal(ig2.imageUrl, null, 'hôte hors allowlist');
  assert.equal(ig2.saves, null);
  assert.equal(ig2.reach, null);
  assert.equal(ig2.engagementRate, null, 'portée inconnue -> taux inconnu, pas 0');

  const li = byId['li-9001'];
  assert.equal(li.engagementRate, 4.5, 'taux LinkedIn déjà en % côté fournisseur : pas de double ×100');
  assert.equal(li.impressions, 3000);
  assert.equal(li.saves, null, 'LinkedIn ne fournit pas les enregistrements');
  assert.deepEqual(li.reactionsByType, { LIKE: 80, PRAISE: 10 });
  assert.equal(li.measured, true);
  assert.equal(byId['li-9002'].engagementRate, null);
  assert.equal(byId['li-9002'].measured, false);

  // rétrocompatibilité : champs historiques toujours présents
  for (const p of list) ['id', 'platform', 'type', 'title', 'publishedAt', 'views', 'likes', 'comments', 'shares', 'saves', 'interactions', 'engagementRate'].forEach((k) => assert.ok(k in p, `${p.id}.${k}`));
  assert.equal(tt.url, 'https://www.tiktok.com/@studio/video/1');
  // tri et filtre plateforme
  const sorted = (await ctx.get('/api/posts?platform=instagram&sort=engagementRate')).json();
  assert.equal(sorted[0].id, 'ig-1');
  assert.equal(sorted.at(-1).id, 'ig-2', 'null en dernier');
  assert.ok(!JSON.stringify(list).includes('javascript:'));
});

test('/overview : totaux, deltas, périodLabel, null ≠ 0, topPosts / latestPosts', async () => {
  const ctx = await setup({ platforms: ['tiktok'] });
  const dates = agg.lastDates(190, T0);
  await ctx.store.recordSnapshot('tiktok', dates[190 - 31], 800); // veille du début de la période de 30 j
  const ov = (await ctx.get('/api/overview?period=30')).json();
  const { totals } = ov;
  assert.equal(totals.followers.value, 1000);
  assert.equal(totals.followers.previous, 800);
  assert.equal(totals.followers.delta, 25);
  assert.equal(totals.followers.periodLabel, 'vs 30 j précédents');
  assert.equal(totals.followers.reason, null);
  assert.equal(totals.interactions.value, 65);
  assert.equal(totals.interactions.previous, 20);
  assert.equal(totals.interactions.delta, 225);
  assert.equal(totals.engagementRate.value, 6.5);
  assert.equal(totals.engagementRate.previous, 4);
  assert.equal(totals.engagementRate.delta, 2.5);
  assert.equal(totals.engagementRate.deltaUnit, 'points');
  assert.match(totals.engagementRate.basis, /pondéré/);
  assert.deepEqual(totals.includedPlatforms, ['tiktok']);

  // Plateformes non connectées : valeurs null (jamais 0) avec raison
  assert.equal(ov.kpisByPlatform.instagram.followers.value, null);
  assert.equal(ov.kpisByPlatform.instagram.interactions.value, null);
  assert.equal(ov.kpisByPlatform.instagram.interactions.delta, null);
  assert.match(ov.kpisByPlatform.instagram.followers.reason, /non connectée/i);
  assert.equal(ov.kpisByPlatform.tiktok.engagementRate.value, 6.5);

  assert.deepEqual(ov.topPosts.map((p) => p.id), ['tt-1']);
  assert.deepEqual(ov.latestPosts.map((p) => p.id), ['tt-1']);
  assert.ok(ov.kpis && ov.perPlatform && ov.series && ov.distribution, 'champs historiques conservés');
});

test('/overview : historique insuffisant -> previous/delta null et raison explicite', async () => {
  const ctx = await setup({ platforms: ['tiktok'] }); // aucun instantané antérieur
  const ov = (await ctx.get('/api/overview?period=30')).json();
  const f = ov.totals.followers;
  assert.equal(f.value, 1000);
  assert.equal(f.previous, null);
  assert.equal(f.delta, null);
  assert.match(f.reason, /historique insuffisant : premier relevé le 2026-09-30/i);

  // période 90 j : une collecte de 150 j ne couvre pas 2 × 90 j -> pas de comparaison des interactions
  const raw = tiktokRaw(T0);
  raw.details.coverage.windowDays = 150;
  const ctx2 = makeApp({ providers: { tiktok: stubProvider('tiktok', raw) }, now: () => T0 });
  await ctx2.store.setToken('tiktok', tok());
  const cookie2 = await login(ctx2.app);
  const ov90 = (await ctx2.app.inject({ url: '/api/overview?period=90', headers: { cookie: cookie2 } })).json();
  assert.equal(ov90.totals.interactions.value, 85);
  assert.equal(ov90.totals.interactions.previous, null);
  assert.equal(ov90.totals.interactions.delta, null);
  assert.match(ov90.totals.interactions.reason, /couvre 150 j.*180/);
  assert.equal(ov90.totals.interactions.periodLabel, 'vs 90 j précédents');
});

test('/overview : totaux inter-réseaux pondérés (audience connue uniquement)', async () => {
  const ctx = await setup({ platforms: ['tiktok', 'instagram', 'linkedin'] });
  const dates = agg.lastDates(190, T0);
  await ctx.store.recordSnapshot('tiktok', dates[190 - 31], 800);
  await ctx.store.recordSnapshot('instagram', dates[190 - 31], 1800);
  await ctx.store.recordSnapshot('linkedin', dates[190 - 31], 250);
  const ov = (await ctx.get('/api/overview?period=30')).json();
  assert.equal(ov.totals.followers.value, 3300);
  assert.equal(ov.totals.followers.previous, 2850);
  // interactions : 65 (tiktok) + 160 + 11 (ig-2 : 10+1) + 95 (li-9001 : 90+1+4) + 0 (li-9002) ; saves LinkedIn ignorés
  assert.equal(ov.totals.interactions.value, 65 + 171 + 95);
  // engagement pondéré : seules les publications d'audience connue (>0) comptent
  const inter = 65 + 160 + 95; const base = 1000 + 2000 + 3000;
  assert.equal(ov.totals.engagementRate.value, Math.round((inter / base) * 10000) / 100);
  assert.equal(ov.totals.engagementRate.postsCounted, 3);
  // LinkedIn : 12 mois de collecte (360 j) -> comparaison possible ; TikTok/Instagram 190 j >= 60 aussi
  assert.notEqual(ov.totals.interactions.previous, null);
});

test('/overview : collecte tronquée -> comparaison désactivée avec raison', async () => {
  const raw = tiktokRaw(T0);
  raw.details.coverage.truncated = true;
  const providers = { tiktok: stubProvider('tiktok', raw), instagram: stubProvider('instagram', instagramRaw(T0)), linkedin: stubProvider('linkedin', linkedinRaw(T0)) };
  const ctx = makeApp({ providers, now: () => T0 });
  await ctx.store.setToken('tiktok', tok());
  const cookie = await login(ctx.app);
  const ov = (await ctx.app.inject({ url: '/api/overview?period=30', headers: { cookie } })).json();
  assert.equal(ov.totals.interactions.previous, null);
  assert.match(ov.totals.interactions.reason, /collecte partielle/);
});

test('/overview : aucune plateforme connectée -> tout null avec raison, jamais 0', async () => {
  const ctx = await setup({ platforms: [] });
  const ov = (await ctx.get('/api/overview')).json();
  for (const k of ['followers', 'interactions', 'engagementRate']) {
    assert.equal(ov.totals[k].value, null);
    assert.equal(ov.totals[k].delta, null);
    assert.equal(ov.totals[k].reason, 'Aucune plateforme connectée.');
  }
  assert.deepEqual(ov.topPosts, []);
  assert.deepEqual(ov.latestPosts, []);
});

test('/overview : latestPosts = 6 dernières par date, topPosts = meilleures par interactions', async () => {
  const raw = tiktokRaw(T0);
  raw.posts = Array.from({ length: 8 }, (_, i) => ({ ...raw.posts[0], id: `tt-n${i}`, publishedAt: new Date(T0 - (i + 1) * DAY).toISOString(), likes: i === 5 ? 9999 : 10 + i, coverUrl: null }));
  const providers = { tiktok: stubProvider('tiktok', raw), instagram: stubProvider('instagram', instagramRaw(T0)), linkedin: stubProvider('linkedin', linkedinRaw(T0)) };
  const ctx = makeApp({ providers, now: () => T0 });
  await ctx.store.setToken('tiktok', tok());
  const cookie = await login(ctx.app);
  const ov = (await ctx.app.inject({ url: '/api/overview?period=30', headers: { cookie } })).json();
  assert.equal(ov.topPosts[0].id, 'tt-n5');
  assert.equal(ov.topPosts.length, 6);
  assert.deepEqual(ov.latestPosts.map((p) => p.id), ['tt-n0', 'tt-n1', 'tt-n2', 'tt-n3', 'tt-n4', 'tt-n5']);
});

test('/status : échéances des jetons, compte, dernier relevé réel, TTL', async () => {
  const ctx = await setup({ platforms: ['tiktok'] });
  const before = (await ctx.get('/api/status')).json().platforms.tiktok;
  assert.equal(before.lastFetchAt, null, 'aucune lecture réelle encore');
  await ctx.get('/api/platforms/tiktok/stats');
  const st = (await ctx.get('/api/status')).json();
  const p = st.platforms.tiktok;
  assert.equal(p.lastFetchAt, new Date(T0).toISOString());
  assert.equal(p.expiresAt, new Date(T0 + 20 * DAY).toISOString());
  assert.deepEqual(p.account, { name: 'Studio', handle: '@studio' });
  assert.ok(Array.isArray(p.notes));
  assert.equal(p.cacheTtlSeconds, 900);
  assert.ok('refreshExpiresAt' in p && 'refreshable' in p && 'connectedAt' in p);
  assert.equal(st.platforms.linkedin.cacheTtlSeconds, 43200);
  assert.equal(st.platforms.instagram.account, null);
  const body = JSON.stringify(st);
  for (const c of Object.values(CANARY)) assert.ok(!body.includes(c));
  assert.ok(!/accessToken|refreshToken/.test(body));
});
