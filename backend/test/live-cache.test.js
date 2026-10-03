// Cache persistant chiffré (cache.enc.json) : aller-retour, canaris, corruption, purge, bornes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeApp, login, stubProvider, FakeClock, TEST_KEY, tmpDir } from './helpers.js';
import { encrypt, decrypt } from '../src/crypto.js';
import { CacheFile, CACHE_SCHEMA, scrub } from '../src/cachefile.js';
import { tiktokRaw, instagramRaw, linkedinRaw, CANARY, DAY } from './integration-fixtures.js';

const ORIGIN = 'https://dash.example.test';
const tok = (clock) => ({ accessToken: CANARY.access, refreshToken: CANARY.refresh, expiresAt: clock.now() + 20 * DAY });

function providersFor(clock, counters = {}) {
  const count = (k) => { counters[k] = (counters[k] || 0) + 1; };
  const igRaw = () => { const r = instagramRaw(clock.now()); r.comments = [{ id: 'c1', text: CANARY.comment, author: 'Visiteur', handle: '@visiteur', platform: 'instagram' }]; r.details.oauthState = CANARY.state; return r; };
  return {
    tiktok: stubProvider('tiktok', () => { count('tiktok'); return tiktokRaw(clock.now()); }),
    instagram: stubProvider('instagram', () => { count('instagram'); return igRaw(); }, { fetchInsights: async () => ({ generatedAt: 'x', views: { total: { value: 5, previous: 1 } }, interactions: { comments: { value: 3, previous: 2 } }, errors: {}, notes: [] }) }),
    linkedin: stubProvider('linkedin', () => { count('linkedin'); return linkedinRaw(clock.now()); })
  };
}

async function boot({ clock = new FakeClock(), cfg, dir, counters = {}, tokens = ['tiktok', 'instagram', 'linkedin'] } = {}) {
  const ctx = makeApp({ cfg, providers: providersFor(clock, counters), now: clock.now, persist: true, env: { LINKEDIN_COMMUNITY_API: 'true', LINKEDIN_ORGANIZATION_ID: '1', ...(dir ? { DATA_DIR: dir } : {}) } });
  for (const p of tokens) if (!(await ctx.store.getToken(p))) await ctx.store.setToken(p, tok(clock));
  ctx.clock = clock;
  ctx.cookie = await login(ctx.app);
  ctx.get = (url) => ctx.app.inject({ url, headers: { cookie: ctx.cookie } });
  ctx.file = path.join(ctx.cfg.dataDir, 'cache.enc.json');
  ctx.readCache = () => JSON.parse(decrypt(JSON.parse(fs.readFileSync(ctx.file, 'utf8')), TEST_KEY));
  return ctx;
}

async function warm(ctx) {
  for (const p of ['tiktok', 'instagram', 'linkedin']) await ctx.get(`/api/platforms/${p}/stats`);
  await ctx.get('/api/platforms/instagram/insights?period=30');
  await ctx.service.settle();
  await ctx.service.flushCache();
}

test('cache persistant : fichier séparé, chiffré AES-256-GCM, mode 0600, écriture atomique, version de schéma', async () => {
  const ctx = await boot();
  await warm(ctx);
  assert.ok(fs.existsSync(ctx.file));
  assert.notEqual(path.basename(ctx.file), 'store.enc.json');
  assert.equal(fs.statSync(ctx.file).mode & 0o777, 0o600);
  const box = JSON.parse(fs.readFileSync(ctx.file, 'utf8'));
  assert.equal(box.alg, 'aes-256-gcm');
  assert.ok(!fs.readFileSync(ctx.file, 'utf8').includes('Studio IG'), 'rien en clair sur disque');
  assert.ok(!fs.readdirSync(ctx.cfg.dataDir).some((f) => f.endsWith('.tmp')), 'aucun fichier temporaire résiduel');
  const data = ctx.readCache();
  assert.equal(data.schema, CACHE_SCHEMA);
  assert.deepEqual(Object.keys(data.platforms).sort(), ['instagram', 'linkedin', 'tiktok']);
  assert.equal(data.platforms.tiktok.data.followers, 1000);
  assert.equal(data.platforms.instagram.data.posts.length, 2);
  assert.ok(data.platforms.instagram.insights['30'].body.interactions.comments.value === 3, 'compteur de commentaires des insights conservé');
});

test('cache persistant : AUCUN commentaire, jeton, état OAuth ni secret (canaris) ; LinkedIn réduit aux stats de Page', async () => {
  const ctx = await boot();
  await warm(ctx);
  const plain = decrypt(JSON.parse(fs.readFileSync(ctx.file, 'utf8')), TEST_KEY);
  for (const [name, v] of Object.entries(CANARY)) assert.ok(!plain.includes(v), `canari ${name} persisté`);
  assert.ok(!plain.includes('Visiteur') && !plain.includes('@visiteur'), 'auteurs de commentaires absents');
  const data = JSON.parse(plain);
  assert.equal(data.platforms.instagram.data.comments, undefined);
  assert.equal(data.platforms.tiktok.data.comments, undefined);
  const li = data.platforms.linkedin.data;
  assert.deepEqual(Object.keys(li).sort(), ['account', 'dailyNewFollowers', 'dailyViews', 'followers'], 'LinkedIn : ni publications ni détails ni activité de membres');
  assert.ok(!plain.includes('Membre LinkedIn') && !plain.includes('reactionsByType'));
  // URLs d'image signées (expirables) jamais écrites
  assert.ok(!plain.includes('cdninstagram') && !plain.includes('tiktokcdn'), 'aucune URL d\'image expirable persistée');
  assert.equal(data.platforms.instagram.data.posts[0].thumbnailUrl, null);
  assert.ok(!/accessToken|refreshToken/.test(plain));
});

test('cache persistant : au redémarrage, premier affichage instantané sans appel fournisseur (données fraîches)', async () => {
  const clock = new FakeClock();
  const a = await boot({ clock });
  await warm(a);
  // « redémarrage » : nouvelle instance, même volume de données, mêmes jetons, aucun appel fournisseur autorisé
  const counters = {};
  const b = await boot({ clock, cfg: a.cfg, counters });
  clock.t += 60_000;
  const restored = await b.service.hydrate();
  assert.deepEqual(restored.restored.sort(), ['instagram', 'linkedin', 'tiktok']);
  const t0 = Date.now();
  b.cookie = await login(b.app);
  const tt = (await b.get('/api/platforms/tiktok/stats')).json();
  const ig = (await b.get('/api/platforms/instagram/stats')).json();
  assert.ok(Date.now() - t0 < 1000);
  assert.equal(tt.kpis.followers.value, 1000);
  assert.equal(ig.kpis.followers.value, 2000);
  assert.equal(tt.stale, false);
  assert.equal(counters.tiktok || 0, 0, 'aucun appel TikTok pour le premier affichage');
  assert.equal(counters.instagram || 0, 0, 'aucun appel Instagram pour le premier affichage');
  assert.deepEqual(ig.loading, ['post_insights', 'comments', 'audience'], 'commentaires non persistés : complétés au palier lourd');
  assert.equal(ig.details.profile.profilePictureUrl, null);
  const ins = (await b.get('/api/platforms/instagram/insights?period=30')).json();
  assert.equal(ins.views.total.value, 5, 'insights restaurés');
  assert.equal(ins.stale, false);
  const comments = (await b.get('/api/comments?platform=instagram')).json();
  assert.equal(comments.items.length, 0);
  assert.ok(comments.unavailable.some((u) => u.platform === 'instagram'));
  // LinkedIn restauré : uniquement Page/followers, aucune publication ni commentaire
  const li = (await b.get('/api/platforms/linkedin/stats')).json();
  assert.equal(li.kpis.followers.value, 300);
  assert.equal(li.postsCount, 0);
  assert.equal((await b.get('/api/comments?platform=linkedin')).json().items.length, 0);
  assert.equal(counters.linkedin || 0, 0, 'LinkedIn restauré récemment : pas de relecture (budget d\'appels)');
});

test('cache persistant : données restaurées périmées -> servies immédiatement puis revalidées en fond', async () => {
  const clock = new FakeClock();
  const a = await boot({ clock });
  await warm(a);
  clock.t += 2 * 3_600_000;
  const counters = {};
  const b = await boot({ clock, cfg: a.cfg, counters });
  await b.service.hydrate();
  b.cookie = await login(b.app);
  const r = (await b.get('/api/platforms/tiktok/stats')).json();
  assert.equal(r.stale, true);
  assert.equal(r.kpis.followers.value, 1000);
  await b.service.settle();
  assert.ok(counters.tiktok >= 1, 'revalidation en arrière-plan');
});

test('cache persistant : fichier corrompu, tronqué, mauvaise clé ou schéma inconnu -> ignoré sans crash', async () => {
  const clock = new FakeClock();
  const a = await boot({ clock });
  await warm(a);
  const good = fs.readFileSync(a.file, 'utf8');
  const variants = {
    'texte quelconque': 'ceci n\'est pas du JSON',
    'JSON tronqué': good.slice(0, Math.floor(good.length / 2)),
    'chiffré avec une autre clé': JSON.stringify(encrypt(JSON.stringify({ schema: CACHE_SCHEMA, platforms: {} }), 'a'.repeat(64))),
    'schéma inconnu': JSON.stringify(encrypt(JSON.stringify({ schema: 999, platforms: { tiktok: { data: {} } } }), TEST_KEY)),
    'étiquette GCM altérée': good.replace(/"tag":"[^"]+"/, '"tag":"AAAAAAAAAAAAAAAAAAAAAA=="'),
    'plateformes absentes': JSON.stringify(encrypt(JSON.stringify({ schema: CACHE_SCHEMA }), TEST_KEY)),
    'fichier vide': ''
  };
  for (const [name, content] of Object.entries(variants)) {
    fs.writeFileSync(a.file, content);
    const counters = {};
    const b = await boot({ clock, cfg: a.cfg, counters });
    const r = await b.service.hydrate();
    assert.deepEqual(r.restored, [], name);
    b.cookie = await login(b.app);
    const res = await b.get('/api/platforms/tiktok/stats');
    assert.equal(res.statusCode, 200, `${name} : le service démarre et lit le fournisseur`);
    assert.ok(counters.tiktok >= 1, name);
  }
  fs.rmSync(a.file);
  const c = await boot({ clock, cfg: a.cfg });
  assert.deepEqual((await c.service.hydrate()).restored, [], 'fichier absent');
});

test('cache persistant : purge à la déconnexion et au démarrage pour les plateformes déconnectées', async () => {
  const clock = new FakeClock();
  const a = await boot({ clock });
  await warm(a);
  assert.ok(a.readCache().platforms.instagram);
  const out = await a.app.inject({ method: 'POST', url: '/api/auth/instagram/disconnect', headers: { cookie: a.cookie, origin: ORIGIN }, payload: {} });
  assert.equal(out.statusCode, 200);
  await a.service.flushCache();
  assert.equal(a.readCache().platforms.instagram, undefined, 'plateforme déconnectée purgée du cache disque');
  assert.ok(a.readCache().platforms.tiktok, 'les autres sont conservées');
  assert.equal(a.service.currentRaw('instagram'), null);
  // une lecture en vol au moment de la déconnexion ne ressuscite rien
  // démarrage : cache contenant une plateforme dont le jeton a disparu entre-temps
  await a.store.deleteToken('tiktok');
  const b = await boot({ clock, cfg: a.cfg, tokens: ['linkedin'] });
  const r = await b.service.hydrate();
  assert.ok(r.purged.includes('tiktok'));
  assert.ok(!r.restored.includes('tiktok'));
  assert.equal(b.readCache().platforms.tiktok, undefined, 'fichier réécrit sans la plateforme déconnectée');
});

test('cache persistant : une lecture en vol pendant la déconnexion est jetée', async () => {
  const clock = new FakeClock();
  let release;
  const gate = new Promise((r) => { release = r; });
  const ctx = makeApp({ providers: { ...providersFor(clock), tiktok: stubProvider('tiktok', async () => { await gate; return tiktokRaw(clock.now()); }) }, now: clock.now, persist: true });
  await ctx.store.setToken('tiktok', tok(clock));
  const run = ctx.service.runTier('tiktok', 'heavy');
  await new Promise((r) => setImmediate(r));
  ctx.service.forget('tiktok');
  release();
  assert.equal(await run, null);
  assert.equal(ctx.service.currentRaw('tiktok'), null);
});

test('cache persistant : PERSIST_CACHE=false n\'écrit rien', async () => {
  const clock = new FakeClock();
  const ctx = makeApp({ providers: providersFor(clock), now: clock.now, persist: true, env: { PERSIST_CACHE: 'false' } });
  await ctx.store.setToken('tiktok', tok(clock));
  await ctx.service.runTier('tiktok', 'heavy');
  assert.equal(await ctx.service.flushCache(), false);
  assert.ok(!fs.existsSync(path.join(ctx.cfg.dataDir, 'cache.enc.json')));
  assert.deepEqual(await ctx.service.hydrate(), { restored: [], purged: [] });
});

test('CacheFile : taille bornée (rien d\'écrit au-delà), scrub retire jetons / commentaires / URL d\'images', async () => {
  const dir = tmpDir();
  const small = new CacheFile({ dataDir: dir, keyHex: TEST_KEY, maxBytes: 200 });
  assert.equal(await small.save({ tiktok: { data: { notes: 'x'.repeat(5000) } } }), false);
  assert.ok(!fs.existsSync(small.file));
  const ok = new CacheFile({ dataDir: dir, keyHex: TEST_KEY });
  assert.equal(await ok.save({ tiktok: { data: { a: 1 } } }), true);
  assert.equal((await ok.load()).platforms.tiktok.data.a, 1);
  const cleaned = scrub({ comments: [{ text: 'secret' }], comment_count: 3, accessToken: 'a', nested: { refresh_token: 'b', coverUrl: 'https://x', title: 'ok', comments: 12 }, avatarUrl: 'u' });
  assert.deepEqual(cleaned, { comment_count: 3, nested: { coverUrl: null, title: 'ok', comments: 12 }, avatarUrl: null });
  await ok.remove();
  assert.ok(!fs.existsSync(ok.file));
});

test('persistance : écritures groupées (une seule écriture pour plusieurs changements) et arrêt propre', async () => {
  const clock = new FakeClock();
  const ctx = await boot({ clock });
  await ctx.service.runTier('tiktok', 'heavy');
  await ctx.service.runTier('instagram', 'heavy');
  assert.ok(!fs.existsSync(ctx.file), 'écriture différée (pas à chaque lecture)');
  await ctx.service.close();
  assert.ok(fs.existsSync(ctx.file), 'close() écrit le cache');
  assert.deepEqual(Object.keys(ctx.readCache().platforms).sort(), ['instagram', 'tiktok']);
  await ctx.app.close();
});
