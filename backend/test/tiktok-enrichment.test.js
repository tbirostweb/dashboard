// Enrichissement TikTok : profil, couverture, cadence, durées, engagement, 429, refresh. Fetch simulé.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { testConfig } from './helpers.js';
import { createTikTokProvider, durationBucket, engagementRate } from '../src/providers/tiktok.js';
import { ttFetch, video, okEnv, errEnv, FULL_USER, TT_TOKEN, DAY } from './fixtures-tiktok.js';

const NOW = Date.UTC(2026, 8, 30, 12);
const mk = (fetch, extra = {}) => {
  const cfg = testConfig();
  cfg.tiktok = { ...cfg.tiktok, retryDelayMs: 1, ...extra };
  return createTikTokProvider(cfg, { fetch, now: () => NOW });
};
const run = (fetch, extra) => mk(fetch, extra).fetchData(TT_TOKEN);
const one = (videos, over = {}) => ({ pages: [{ videos, has_more: false, cursor: 1 }], ...over });

test('profil complet : tous les champs exposés, saves null, URLs expirantes signalées', async () => {
  const f = ttFetch(one([video(NOW, 2)]));
  const r = await run(f);
  assert.deepEqual(r.details.profile, {
    username: 'studiotest', displayName: 'Studio Test', bio: 'Bio de test', isVerified: true,
    avatarUrl: FULL_USER.avatar_url, profileDeepLink: 'https://vm.tiktok.com/xyz',
    followerCount: 4200, followingCount: 12, likesCount: 99000, videoCount: 57
  });
  assert.equal(r.details.imageUrlsExpire, true);
  assert.equal(r.followers, 4200);
  assert.equal(r.posts[0].saves, null);
  assert.equal(r.posts[0].url, 'https://www.tiktok.com/@studiotest/video/1002');
  assert.equal(r.posts[0].coverUrl, 'https://p16.example/cover2.jpeg');
  assert.match(f.hits.user[0], /following_count/);
  assert.match(f.hits.user[0], /is_verified/);
  assert.match(f.hits.list[0].fields, /cover_image_url/);
});

test('profil partiel : scope stats refusé -> champs null + note, sans casser', async () => {
  const f = ttFetch(one([video(NOW, 2)], {
    user: (fields) => (/follower_count/.test(fields) ? errEnv('scope_not_authorized', 403) : okEnv({ user: { open_id: 'o', display_name: 'D', username: 'u', bio_description: 'b' } }))
  }));
  const r = await run(f);
  assert.equal(f.hits.user.length, 2);
  assert.equal(r.followers, null);
  const p = r.details.profile;
  assert.equal(p.followerCount, null); assert.equal(p.followingCount, null); assert.equal(p.likesCount, null); assert.equal(p.videoCount, null);
  assert.equal(p.isVerified, null); assert.equal(p.avatarUrl, null);
  assert.equal(p.username, 'u');
  assert.ok(r.details.notes.some((n) => /user\.info\.stats/.test(n)));
});

test('profil minimal : scope profile aussi refusé -> repli basique', async () => {
  const f = ttFetch(one([], {
    user: (fields) => (/username|follower/.test(fields) ? errEnv('scope_not_authorized', 403) : okEnv({ user: { open_id: 'o', display_name: 'Seul' } }))
  }));
  const r = await run(f);
  assert.equal(f.hits.user.length, 3);
  assert.equal(r.details.profile.displayName, 'Seul');
  assert.equal(r.details.profile.username, null);
  assert.ok(r.details.notes.some((n) => /user\.info\.profile/.test(n)));
});

test('une erreur auth sur le profil n\'est pas masquée par le repli', async () => {
  const f = ttFetch({ user: () => errEnv('access_token_invalid', 401) });
  await assert.rejects(run(f), (e) => e.code === 'auth');
});

test('champs vidéo refusés -> repli sur les champs historiques', async () => {
  const f = ttFetch({
    listFn: (fields) => (/cover_image_url/.test(fields)
      ? errEnv('invalid_params', 400)
      : okEnv({ videos: [video(NOW, 3, { cover_image_url: undefined, height: undefined, width: undefined })], has_more: false }))
  });
  const r = await run(f);
  assert.equal(f.hits.list.length, 2);
  assert.doesNotMatch(f.hits.list[1].fields, /cover_image_url/);
  assert.equal(r.posts.length, 1);
  // cover absente du list -> video/query appelé pour rafraîchir
  assert.equal(f.hits.query.length, 1);
  assert.equal(r.posts[0].coverUrl, 'https://p16.example/fresh1003.jpeg');
});

test('video/query non appelé quand cover_image_url est présent', async () => {
  const f = ttFetch(one([video(NOW, 1), video(NOW, 2)]));
  await run(f);
  assert.equal(f.hits.query.length, 0);
});

test('pagination + truncated : plafond de pages atteint avec has_more vrai', async () => {
  const page = (i) => ({ videos: Array.from({ length: 20 }, (_, k) => video(NOW, 1 + i * 10 + Math.floor(k / 2), { id: `v${i}-${k}` })), has_more: true, cursor: 1000 + i });
  const f = ttFetch({ pages: Array.from({ length: 12 }, (_, i) => page(i)) });
  const r = await run(f);
  assert.equal(f.hits.list.length, 10);
  assert.equal(f.hits.list[1].body.cursor, 1000);
  assert.equal(r.details.coverage.truncated, true);
  assert.equal(r.details.coverage.videosFetched, 200);
  assert.equal(r.details.coverage.maxPages, 10);
  assert.equal(r.details.coverage.windowDays, 190);
  assert.ok(r.notes.some((n) => /tronqué/.test(n)));
});

test('fenêtre atteinte : pas de truncated même si has_more', async () => {
  const f = ttFetch({ pages: [{ videos: [video(NOW, 5), video(NOW, 400, { id: 'old' })], has_more: true, cursor: 1 }] });
  const r = await run(f);
  assert.equal(r.details.coverage.truncated, false);
  assert.equal(r.details.coverage.videosFetched, 2);
  assert.equal(r.posts.length, 1);
  assert.equal(f.hits.list.length, 1);
});

test('engagementRate : (likes+commentaires+partages)/vues ; vues=0 ou inconnues -> null', async () => {
  assert.equal(engagementRate(2000, 100, 10, 5), 115 / 2000);
  assert.equal(engagementRate(0, 100, 10, 5), null);
  const f = ttFetch(one([
    video(NOW, 1),
    video(NOW, 2, { view_count: 0 }),
    video(NOW, 3, { view_count: undefined })
  ]));
  const r = await run(f);
  assert.equal(r.posts[0].engagementRate, 0.0575);
  assert.equal(r.posts[1].engagementRate, null);
  assert.equal(r.posts[2].engagementRate, null);
});

test('buckets de durée aux bornes exactes', () => {
  assert.equal(durationBucket(0), '≤15 s');
  assert.equal(durationBucket(15), '≤15 s');
  assert.equal(durationBucket(16), '15–30 s');
  assert.equal(durationBucket(30), '15–30 s');
  assert.equal(durationBucket(31), '30–60 s');
  assert.equal(durationBucket(60), '30–60 s');
  assert.equal(durationBucket(61), '> 60 s');
  assert.equal(durationBucket(null), null);
});

test('durée : champ absent -> null (pas 0) et type historique conservé', async () => {
  const f = ttFetch(one([video(NOW, 1, { duration: undefined }), video(NOW, 2, { duration: 60 }), video(NOW, 3, { duration: 61 })]));
  const r = await run(f);
  assert.equal(r.posts[0].durationSeconds, null);
  assert.equal(r.posts[0].durationBucket, null);
  assert.equal(r.posts[0].type, 'Vidéo');
  assert.equal(r.posts[1].durationSeconds, 60);
  assert.equal(r.posts[1].durationBucket, '30–60 s');
  assert.equal(r.posts[1].type, 'Vidéo courte');
  assert.equal(r.posts[2].type, 'Vidéo longue');
});

test('cadence : posts/semaine sur la fenêtre couverte, null si < 2 vidéos', async () => {
  const f = ttFetch(one([video(NOW, 1), video(NOW, 5), video(NOW, 10)]));
  const r = await run(f);
  // 3 vidéos sur 190 jours = 3 / (190/7) = 0.11
  assert.equal(r.details.cadence.postsPerWeek, 0.11);
  assert.equal(r.details.cadence.lastPostAt, new Date(NOW - DAY).toISOString());

  const f1 = ttFetch(one([video(NOW, 1)]));
  const r1 = await run(f1);
  assert.equal(r1.details.cadence.postsPerWeek, null);
  assert.equal(r1.details.cadence.lastPostAt, new Date(NOW - DAY).toISOString());

  const f0 = ttFetch(one([]));
  const r0 = await run(f0);
  assert.equal(r0.details.cadence.postsPerWeek, null);
  assert.equal(r0.details.cadence.lastPostAt, null);
});

test('429 : retry puis succès', async () => {
  let n = 0;
  const f = ttFetch({
    listFn: () => (++n < 3 ? errEnv('rate_limit_exceeded', 429) : okEnv({ videos: [video(NOW, 1)], has_more: false }))
  });
  const r = await run(f);
  assert.equal(n, 3);
  assert.equal(r.posts.length, 1);
});

test('429 persistant : 3 tentatives max puis erreur rate_limit en français', async () => {
  let n = 0;
  const f = ttFetch({ listFn: () => { n++; return errEnv('rate_limit_exceeded', 429); } });
  await assert.rejects(run(f), (e) => {
    assert.equal(e.code, 'rate_limit');
    assert.match(e.message, /Limite de requêtes TikTok/);
    return true;
  });
  assert.equal(n, 3);
});

test('429 avec code rate_limit_exceeded en HTTP 200 : même traitement', async () => {
  let n = 0;
  const f = ttFetch({ listFn: () => { n++; return { json: { data: {}, error: { code: 'rate_limit_exceeded' } } }; } });
  await assert.rejects(run(f), (e) => e.code === 'rate_limit');
  assert.equal(n, 3);
});

test('refresh : renvoie le NOUVEAU refresh_token et refresh_expires_in', async () => {
  const f = ttFetch();
  const t = await mk(f).refresh(TT_TOKEN);
  assert.equal(t.accessToken, 'act.new');
  assert.equal(t.refreshToken, 'rft.new');
  assert.equal(t.refreshExpiresIn, 31536000);
  assert.equal(t.refreshExpiresAt, NOW + 31536000 * 1000);
  assert.equal(t.expiresAt, NOW + 86400 * 1000);
  assert.equal(t.userId, 'open-1');
});

test('refresh : sans refresh_token dans la réponse, l\'ancien est conservé', async () => {
  const { fakeFetch } = await import('./helpers.js');
  const f = fakeFetch([[/oauth\/token\//, () => ({ json: { access_token: 'act.x', expires_in: 86400 } })]]);
  const t = await mk(f).refresh({ ...TT_TOKEN, refreshExpiresAt: 42 });
  assert.equal(t.refreshToken, 'rft.old-refresh');
  assert.equal(t.refreshExpiresAt, 42);
});

test('aucun jeton ni secret dans la sortie', async () => {
  const f = ttFetch(one([video(NOW, 1)]));
  const r = await run(f);
  const s = JSON.stringify(r);
  assert.ok(!s.includes(TT_TOKEN.accessToken));
  assert.ok(!s.includes('rft.'));
  assert.ok(!s.includes('tt-client-secret'));
  assert.ok(!/access_token|refresh_token|client_secret/.test(s));
});

test('inconnu = null, jamais 0 : profil vide', async () => {
  const f = ttFetch({ user: { open_id: 'o' }, pages: [{ videos: [], has_more: false }] });
  const r = await run(f);
  for (const [k, v] of Object.entries(r.details.profile)) assert.equal(v, null, k);
  assert.equal(r.followers, null);
  assert.notEqual(r.details.profile.followerCount, 0);
});
