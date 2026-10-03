import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLinkedInProvider, buildShareStatsPath, isSponsored } from '../src/providers/linkedin.js';
import { ProviderError } from '../src/http.js';
import { NOW, DAY, ORG_URN, LI_TOKEN, FEED_SCOPES, liConfig, linkedinFetch, mkPost, shareStat, resp } from './fixtures-linkedin.js';

const make = (fetch, linkedin = {}, env = {}, now = () => NOW) => createLinkedInProvider(liConfig(env, linkedin), { fetch, now });
const TOK = { accessToken: LI_TOKEN };
const urlsOf = (f, re) => f.calls.filter((c) => re.test(c.url)).map((c) => decodeURIComponent(c.url));

test('pendingApproval : aucun appel réseau, aucune donnée, details absent', async () => {
  const fetch = linkedinFetch();
  const p = make(fetch, {}, { LINKEDIN_COMMUNITY_API: 'false' });
  assert.equal(p.pendingApproval, true);
  await assert.rejects(() => p.fetchData(TOK), (e) => e instanceof ProviderError && e.code === 'pending_approval');
  assert.equal(fetch.calls.length, 0);
});

test('organisation : champs publics + admin, logo non exposé', async () => {
  const d = (await make(linkedinFetch()).fetchData(TOK)).details;
  assert.deepEqual({ ...d.organization, state: undefined, reason: undefined }, {
    name: 'Studio Test SAS', vanityName: 'studio-test', website: 'https://studio-test.example', description: 'Agence factice.',
    staffCountRange: 'SIZE_11_50', industries: ['urn:li:industry:96'], foundedOn: { year: 2019 }, type: 'COMPANY', state: undefined, reason: undefined
  });
  assert.equal(d.organization.state, 'ok');
  assert.ok(!JSON.stringify(d.organization).includes('logo'));
});

test('followers : total, gains organique/payant, fenêtre calée sur J-2 UTC, facettes top 100', async () => {
  const f = linkedinFetch();
  const r = await make(f).fetchData(TOK);
  const d = r.details.followers;
  assert.equal(d.total, 321);
  assert.equal(r.followers, 321);
  assert.deepEqual(d.gains, [{ date: '2026-09-27', organic: 3, paid: 1 }, { date: '2026-09-28', organic: 5, paid: 0 }]);
  assert.equal(d.latestDataDate, '2026-09-28');
  const j2 = Date.UTC(2026, 8, 29);
  const q = f.calls.map((c) => c.url).find((u) => /FollowerStatistics/.test(u) && /timeIntervals/.test(u));
  assert.match(decodeURIComponent(q), new RegExp(`end:${j2}\\),timeGranularityType:DAY`));
  assert.equal(d.facetsTopN, 100);
  assert.equal(d.facets.country.length, 100);
  assert.deepEqual(d.facets.country[0], { key: 'urn:li:geo:119', count: 120 });
  assert.deepEqual(d.facets.function, [{ key: 'urn:li:function:8', count: 30 }]);
  for (const k of ['seniority', 'industry', 'staffCount', 'region', 'association']) assert.ok(Array.isArray(d.facets[k]), k);
  assert.equal(r.dailyNewFollowers['2026-09-28'], 5);
});

test('pageStats : série jour/mois, sections, appareils, clics, facettes cumulées', async () => {
  const f = linkedinFetch();
  const ps = (await make(f).fetchData(TOK)).details.pageStats;
  assert.equal(ps.state, 'ok');
  assert.deepEqual(ps.daily[1], { date: '2026-09-29', pageViews: 13, uniqueVisitors: 9 });
  assert.deepEqual(ps.bySection, { overview: 150, careers: 60, jobs: 40, lifeAt: 25 });
  assert.deepEqual(ps.byDevice, { desktop: 180, mobile: 120 });
  assert.deepEqual(ps.clicks.desktop, [{ type: 'VISIT_WEBSITE', count: 9 }]);
  assert.deepEqual(ps.byCountry.map((x) => x.count), [80, 50]);
  assert.equal(ps.byFunction[0].count, 33);
  assert.equal(ps.window.granularity, 'DAY');
  const f2 = linkedinFetch();
  const m = (await make(f2, { pageStatsGranularity: 'MONTH' }).fetchData(TOK)).details.pageStats;
  assert.equal(m.window.granularity, 'MONTH');
  assert.ok(urlsOf(f2, /organizationPageStatistics/).some((u) => u.includes('timeGranularityType:MONTH')));
});

test('posts paginés : pages de 100, plafond + truncated, sponsorisés exclus des agrégats organiques', async () => {
  const page = (start) => Array.from({ length: 100 }, (_, i) => mkPost(start + i + 1, 1 + (start + i) / 1000));
  const f = linkedinFetch({ over: [[(u) => /rest\/posts\?/.test(u), (u) => ({ json: { elements: page(Number(/start=(\d+)/.exec(u)[1])) } })]], shareStats: () => [] });
  const r = await make(f, { maxPostPages: 2 }).fetchData(TOK);
  assert.equal(f.calls.filter((c) => /rest\/posts\?/.test(c.url)).length, 2);
  assert.ok(f.calls.some((c) => /count=100/.test(c.url) && /start=100/.test(c.url)));
  assert.equal(r.details.coverage.truncated, true);
  assert.equal(r.details.coverage.postsFetched, 200);
  assert.ok(r.details.notes.some((n) => /tronquées/.test(n)));

  const posts = [mkPost(1, 3), mkPost(2, 4, { adContext: { isDsc: true } }), mkPost(3, 5, { distribution: { feedDistribution: 'NONE' } })];
  const r2 = await make(linkedinFetch({ posts })).fetchData(TOK);
  assert.equal(r2.posts.length, 1);
  assert.equal(r2.details.coverage.sponsoredExcluded, 2);
  assert.equal(r2.details.coverage.truncated, false);
  assert.deepEqual(r2.details.sponsoredPosts.map((p) => p.sponsored), [true, true]);
  assert.equal(r2.posts[0].sponsored, false);
  assert.ok(isSponsored(posts[1]) && isSponsored(posts[2]) && !isSponsored(posts[0]));
  assert.ok(r2.details.notes.some((n) => /sponsoris/.test(n)));
});

test('posts anciens : la pagination s’arrête quand la page sort de la fenêtre', async () => {
  const old = Array.from({ length: 100 }, (_, i) => mkPost(i + 1, 300));
  const f = linkedinFetch({ posts: old });
  const r = await make(f).fetchData(TOK);
  assert.equal(f.calls.filter((c) => /rest\/posts\?/.test(c.url)).length, 1);
  assert.equal(r.posts.length, 0);
  assert.equal(r.details.coverage.truncated, false);
});

test('stats par post : champs, absent = 0 non mesuré, likeCount négatif, lots de 20', async () => {
  const posts = [mkPost(1, 3), mkPost(2, 4), mkPost(3, 5)];
  const r = await make(linkedinFetch({ posts, shareStats: () => [
    shareStat('urn:li:share:1', { impressionCount: 1000, uniqueImpressionsCount: 800, clickCount: 50, likeCount: 40, commentCount: 3, shareCount: 2, engagement: 0.095 }),
    shareStat('urn:li:share:3', { impressionCount: 10, likeCount: -2, commentCount: 0, shareCount: 0 })
  ] })).fetchData(TOK);
  const [a, b, c] = r.posts;
  assert.deepEqual([a.impressions, a.uniqueImpressions, a.clicks, a.reactions, a.comments, a.shares, a.measured, a.sponsored], [1000, 800, 50, 40, 3, 2, true, false]);
  assert.ok(Math.abs(a.engagementRate - 9.5) < 1e-9);
  assert.equal(a.url, 'https://www.linkedin.com/feed/update/urn:li:share:1/');
  assert.deepEqual([b.impressions, b.clicks, b.reactions, b.measured, b.engagementRate], [0, 0, 0, false, null]);
  assert.equal(c.reactions, null);
  assert.equal(c.likes, 0);
  assert.equal(c.measured, true);
  assert.equal(r.details.coverage.statsMeasuredFor, 2);
  assert.ok(r.details.notes.some((n) => /négatif/.test(n)));
  assert.ok(r.details.notes.some((n) => /non mesurées/.test(n)));

  const many = Array.from({ length: 45 }, (_, i) => mkPost(i + 1, 2));
  const f = linkedinFetch({ posts: many, shareStats: () => [] });
  await make(f).fetchData(TOK);
  assert.equal(urlsOf(f, /organizationalEntityShareStatistics\?q=organizationalEntity&organizationalEntity=[^&]*&shares=/).length, 3);
});

test('construction d’URL shares / ugcPosts + repli indexé sur 400', async () => {
  const ids = ['urn:li:share:1', 'urn:li:ugcPost:2'];
  const l = decodeURIComponent(buildShareStatsPath(ORG_URN, ids));
  assert.match(l, /shares=List\(urn:li:share:1\)&ugcPosts=List\(urn:li:ugcPost:2\)/);
  assert.equal(buildShareStatsPath(ORG_URN, ['urn:li:share:1']).includes('ugcPosts'), false);
  const raw = buildShareStatsPath(ORG_URN, ids);
  assert.ok(raw.includes('urn%3Ali%3Ashare%3A1'), 'URN encodés');
  const ix = decodeURIComponent(buildShareStatsPath(ORG_URN, ids, 'indexed'));
  assert.match(ix, /shares\[0\]=urn:li:share:1&ugcPosts\[0\]=urn:li:ugcPost:2/);

  const f = linkedinFetch({ over: [[(u) => /ShareStatistics/.test(u) && /shares=List/.test(decodeURIComponent(u)), resp(400)]] });
  const r = await make(f).fetchData(TOK);
  assert.equal(r.posts[0].measured, true, 'le repli indexé a répondu');
  assert.ok(urlsOf(f, /shares\[0\]/).length >= 1);
});

test('réactions par type : avec scope feed, sans scope (aucun appel socialMetadata)', async () => {
  const f = linkedinFetch();
  const r = await make(f, {}, { LINKEDIN_SCOPES: FEED_SCOPES }).fetchData(TOK);
  assert.deepEqual(r.details.reactionsByType, { LIKE: 14, PRAISE: 4, EMPATHY: 2 });
  assert.deepEqual(r.posts[0].reactionsByType, { LIKE: 7, PRAISE: 2, EMPATHY: 1 });
  assert.equal(r.details.blocks.reactions.state, 'ok');
  assert.equal(urlsOf(f, /socialMetadata/).length, 2);

  const f2 = linkedinFetch();
  const r2 = await make(f2).fetchData(TOK);
  assert.equal(r2.details.reactionsByType, null);
  assert.equal(r2.posts[0].reactionsByType, null);
  assert.equal(r2.details.blocks.reactions.state, 'scope_missing');
  assert.ok(r2.details.notes.some((n) => /scope non accordé/.test(n)));
  assert.equal(f2.calls.filter((c) => /socialMetadata/.test(c.url)).length, 0);
});

test('commentaires : rétention 48 h exposée', async () => {
  const r = await make(linkedinFetch({ shareStats: () => [shareStat('urn:li:share:1', { impressionCount: 1, commentCount: 3 })] })).fetchData(TOK);
  assert.equal(r.comments.length, 1);
  assert.equal(r.comments[0].author, 'Membre LinkedIn');
  assert.equal('retentionHours' in r.comments[0], false, 'forme des commentaires inchangée');
  assert.equal(r.details.retention.commentsHours, 48);
  assert.equal(r.commentsRetentionHours, 48);
});

test('budget : dépassement → note FR + arrêt propre ; compteur remis à zéro à minuit UTC', async () => {
  let t = Date.UTC(2026, 9, 1, 23, 59, 0);
  const f = linkedinFetch();
  const p = make(f, { dailyCallBudget: 4 }, {}, () => t);
  const r = await p.fetchData(TOK);
  assert.equal(f.calls.length, 4, 'aucun appel au-delà du budget');
  assert.deepEqual({ used: r.details.budget.used, limit: r.details.budget.limit }, { used: 4, limit: 4 });
  assert.equal(r.details.budget.resetsAt, '2026-10-02T00:00:00.000Z');
  assert.ok(r.details.notes.some((n) => /^Budget d'appels LinkedIn du jour atteint/.test(n)));
  assert.equal(r.details.blocks.pageStats.state, 'budget_exhausted');
  assert.equal(r.details.blocks.posts.state, 'budget_exhausted');
  assert.equal(r.posts.length, 0);
  assert.equal(r.followers, 321);

  const again = await p.fetchData(TOK);
  assert.equal(f.calls.length, 4, 'toujours épuisé le même jour');
  assert.equal(again.details.blocks.organization.state, 'budget_exhausted');

  t = Date.UTC(2026, 9, 2, 0, 0, 1);
  const next = await p.fetchData(TOK);
  assert.ok(f.calls.length > 4);
  assert.equal(next.details.budget.used, 4);
  assert.equal(next.details.budget.resetsAt, '2026-10-03T00:00:00.000Z');
});

test('budget : les détails (tier 2) ne consomment pas la réserve prioritaire', async () => {
  const f = linkedinFetch({ shareStats: () => [shareStat('urn:li:share:1', { impressionCount: 1, commentCount: 3 })] });
  const r = await make(f, { dailyCallBudget: 90, priorityReserve: 90 }, { LINKEDIN_SCOPES: FEED_SCOPES }).fetchData(TOK);
  assert.equal(f.calls.filter((c) => /socialMetadata|socialActions/.test(c.url)).length, 0);
  assert.equal(r.details.blocks.reactions.state, 'budget_exhausted');
  assert.equal(r.details.blocks.organization.state, 'ok');
});

test('403 sur un bloc : isolé, les autres restent ok', async () => {
  const f = linkedinFetch({ over: [[(u) => /organizationPageStatistics/.test(u), resp(403)], [(u) => /FollowerStatistics/.test(u) && /timeIntervals/.test(u), resp(403)]] });
  const r = await make(f).fetchData(TOK);
  const b = r.details.blocks;
  assert.equal(b.pageStats.state, 'scope_missing');
  assert.match(b.pageStats.reason, /rw_organization_admin/);
  assert.equal(b.followers.state, 'scope_missing');
  assert.equal(b.organization.state, 'ok');
  assert.equal(b.posts.state, 'ok');
  assert.equal(b.postStats.state, 'ok');
  assert.equal(r.details.followers.total, 321);
  assert.equal(r.details.followers.gains, null);
  assert.ok(r.details.followers.facets);
  assert.equal(r.details.pageStats.bySection, null);
  assert.equal(r.posts.length, 2);
});

test('429 : classé rate_limit, un seul appel, aucun retry', async () => {
  const f = linkedinFetch({ over: [[/rest\//, resp(429)]] });
  await assert.rejects(() => make(f).fetchData(TOK), (e) => e.code === 'rate_limit');
  assert.equal(f.calls.length, 1);

  const f2 = linkedinFetch({ over: [[/organizationPageStatistics/, resp(429)]] });
  const r = await make(f2).fetchData(TOK);
  assert.equal(r.details.blocks.pageStats.state, 'not_available');
  assert.match(r.details.blocks.pageStats.reason, /429/);
  assert.equal(f2.calls.filter((c) => /organizationPageStatistics/.test(c.url)).length, 1, 'pas de retry');
  assert.equal(f2.calls.filter((c) => /socialActions|socialMetadata|ShareStatistics.*timeIntervals/.test(c.url)).length, 0, 'appels suspendus après le 429');
});

test('403 sur les deux endpoints organisation → pending_approval (inchangé)', async () => {
  const f = linkedinFetch({ over: [[/organizations\//, resp(403)], [/networkSizes/, resp(403)]] });
  await assert.rejects(() => make(f).fetchData(TOK), (e) => e.code === 'pending_approval');
});

test('aucun jeton ni secret dans la sortie', async () => {
  const r = await make(linkedinFetch({ over: [[/organizationPageStatistics/, resp(403)]] }), {}, { LINKEDIN_SCOPES: FEED_SCOPES }).fetchData(TOK);
  const s = JSON.stringify(r);
  assert.ok(!s.includes(LI_TOKEN) && !s.includes('AQfake') && !s.includes('li-client-secret') && !/Bearer/.test(s));
});

test('entêtes : version d’API et protocole Restli', async () => {
  const f = linkedinFetch();
  await make(f).fetchData(TOK);
  assert.ok(f.calls.every((c) => c.init.headers['Linkedin-Version'] === '202609' && c.init.headers['X-Restli-Protocol-Version'] === '2.0.0'));
});
