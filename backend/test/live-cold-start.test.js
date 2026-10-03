// Démarrage à froid : le palier léger passe TOUJOURS d'abord et n'est jamais attendu derrière le lourd (single-flight par palier).
// Horloge et fournisseurs simulés : le palier lourd dure 14 s SIMULÉES ; aucun réseau, aucun temps réel consommé.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeApp, login, stubProvider, FakeClock } from './helpers.js';
import { Scheduler, LIVE_PLATFORMS } from '../src/scheduler.js';
import { ProviderError } from '../src/http.js';
import { instagramRaw, tiktokRaw, linkedinRaw, DAY } from './integration-fixtures.js';

const HEAVY_MS = 14_000;
const LIGHT_MS = 300;
const tok = (clock) => ({ accessToken: 'tok-test', refreshToken: 'rft-test', expiresAt: clock.now() + 20 * DAY });
const sleep = (clock, ms) => new Promise((r) => clock.setTimeout(r, ms));

async function setup({ lightFails = false, persist = false, cfg, tokens = true } = {}) {
  const clock = new FakeClock();
  const calls = { light: 0, heavy: 0, insights: 0, tiktok: 0, linkedin: 0 };
  const lightFail = { on: lightFails };
  const ig = stubProvider('instagram', async () => { calls.heavy++; await sleep(clock, HEAVY_MS); return instagramRaw(clock.now()); }, {
    heavyPostKeys: [],
    fetchLight: async () => {
      calls.light++;
      await sleep(clock, LIGHT_MS);
      if (lightFail.on) throw new ProviderError('instagram', 'network', 'panne simulée');
      const r = instagramRaw(clock.now());
      return { partial: true, account: r.account, followers: r.followers, posts: r.posts.map((p) => ({ ...p })), details: { profile: { followersCount: r.followers } } };
    },
    fetchInsights: async () => { calls.insights++; return { generatedAt: 'x', views: { total: { value: 5, previous: 1 } }, interactions: {}, profile: {}, audience: null, errors: {}, notes: [] }; }
  });
  const tt = stubProvider('tiktok', () => { calls.tiktok++; return tiktokRaw(clock.now()); }, { fetchLight: async () => { calls.tiktok++; return { ...tiktokRaw(clock.now()), partial: true }; } });
  const li = stubProvider('linkedin', () => { calls.linkedin++; return linkedinRaw(clock.now()); });
  const ctx = makeApp({ cfg, providers: { instagram: ig, tiktok: tt, linkedin: li }, now: clock.now, persist, env: { LINKEDIN_COMMUNITY_API: 'true', LINKEDIN_ORGANIZATION_ID: '1' } });
  if (tokens) await ctx.store.setToken('instagram', tok(clock));
  const scheduler = new Scheduler({ service: ctx.service, presence: ctx.presence, cfg: ctx.cfg, now: clock.now, setTimer: clock.setTimeout, clearTimer: clock.clearTimeout, random: () => 0.5 });
  const cookie = await login(ctx.app);
  const get = (url) => ctx.app.inject({ url, headers: { cookie } });
  return { ...ctx, clock, calls, scheduler, lightFail, get, ig };
}

/** Lance une requête et mesure le temps SIMULÉ écoulé quand elle rend la main. */
async function timedGet(s, url, maxMs = 20_000) {
  const t0 = s.clock.now();
  let res = null; let at = null;
  const p = s.get(url).then((r) => { res = r; at = s.clock.now(); });
  for (let spent = 0; !res && spent <= maxMs; spent += 100) await s.clock.advance(100);
  await p;
  return { res, ms: at - t0 };
}

test('démarrage à froid avec ordonnanceur : la 1re requête revient à la fin du LÉGER (jamais derrière un lourd de 14 s)', async () => {
  const s = await setup();
  s.scheduler.start();
  s.presence.touch(); // reprise : cycle à froid lancé par l'ordonnanceur
  const { res, ms } = await timedGet(s, '/api/platforms/instagram/stats');
  assert.equal(res.statusCode, 200);
  assert.ok(ms <= LIGHT_MS + 200, `1re réponse en ${ms} ms simulées (léger = ${LIGHT_MS} ms, lourd = ${HEAVY_MS} ms)`);
  const b = res.json();
  assert.equal(b.refreshing, true, 'le lourd continue en arrière-plan');
  assert.deepEqual(b.loading, ['post_insights', 'comments', 'audience']);
  assert.equal(s.calls.heavy, 1);
  assert.equal(s.calls.light, 1, 'léger une seule fois (pas de doublon)');
  // le lourd se termine, la réponse suivante est complète, fusionnée sans perte
  await s.clock.advance(HEAVY_MS);
  const full = (await s.get('/api/platforms/instagram/stats')).json();
  assert.deepEqual(full.loading, []);
  assert.equal(full.refreshing, false);
  assert.equal(s.calls.heavy, 1);
  assert.equal(s.calls.light, 1, 'toujours un seul léger après le lourd');
  assert.equal(s.calls.linkedin, 0, 'jamais LinkedIn');
  s.scheduler.stop();
});

test('démarrage à froid sans ordonnanceur : même garantie (léger attendu seul, lourd en fond)', async () => {
  const s = await setup();
  const { res, ms } = await timedGet(s, '/api/platforms/instagram/stats');
  assert.ok(ms <= LIGHT_MS + 200, `${ms} ms`);
  assert.equal(res.json().refreshing, true);
  assert.ok(res.json().loading.length > 0);
  await s.clock.advance(HEAVY_MS);
  await s.service.settle();
  assert.deepEqual((await s.get('/api/platforms/instagram/stats')).json().loading, []);
  assert.equal(s.calls.light, 1);
  assert.equal(s.calls.heavy, 1);
});

test('runTier : un léger ne rejoint jamais un lourd en vol (single-flight par palier) et le lourd attend le léger', async () => {
  const s = await setup();
  const heavy = s.service.runTier('instagram', 'heavy', { direct: true }); // manuel : lourd direct
  const light = s.service.runTier('instagram', 'light');
  assert.notEqual(heavy, light);
  let lightDone = false;
  light.then(() => { lightDone = true; });
  await s.clock.advance(LIGHT_MS + 50);
  assert.equal(lightDone, true, 'léger terminé alors que le lourd (14 s) tourne');
  assert.equal(s.service.runTier('instagram', 'light') !== light, true, 'nouveau léger après la fin du précédent');
  await s.clock.advance(HEAVY_MS);
  await heavy;
  await s.service.settle();
  const raw = s.service.currentRaw('instagram');
  assert.equal(raw.partial, false, 'le lourd n\'est pas écrasé par un léger tardif');
});

test('échec du léger au démarrage à froid : backoff, le lourd n\'est PAS lancé, pas de boucle serrée', async () => {
  const s = await setup({ lightFails: true });
  s.scheduler.start();
  s.presence.touch();
  await s.clock.advance(1000);
  assert.equal(s.calls.light, 1);
  assert.equal(s.calls.heavy, 0, 'pas de quota gaspillé tant que le léger n\'a jamais réussi');
  for (let i = 0; i < 10; i++) { s.presence.touch(); await s.clock.advance(5_000); } // 50 s de plus
  assert.ok(s.calls.light <= 2, `pas de relance serrée : ${s.calls.light} tentatives en ~50 s`);
  assert.equal(s.calls.heavy, 0);
  s.lightFail.on = false; // le fournisseur revient : reprise après backoff, léger puis lourd
  for (let i = 0; i < 20; i++) { s.presence.touch(); await s.clock.advance(30_000); }
  assert.ok(s.calls.heavy >= 1, 'le lourd part une fois le léger réussi');
  s.scheduler.stop();
});

test('insights Instagram sans cache et lourd en cours : état loading immédiat, aucun appel fournisseur', async () => {
  const s = await setup();
  await timedGet(s, '/api/platforms/instagram/stats'); // léger fait, lourd en cours
  const { res, ms } = await timedGet(s, '/api/platforms/instagram/insights?period=30');
  assert.equal(res.statusCode, 200);
  assert.ok(ms < 200, `${ms} ms`);
  const b = res.json();
  assert.equal(b.updatedAt, null);
  assert.equal(b.refreshing, true);
  assert.ok(b.loading.includes('account_insights'));
  assert.equal(b.views, null);
  assert.equal(b.audience, null);
  assert.equal(b.interactions, null);
  assert.equal(b.profile, null);
  assert.ok(Array.isArray(b.series.dates), 'série quotidienne conservée');
  assert.equal(s.calls.insights, 0, 'aucune lecture d\'insights pendant le lourd');
  await s.clock.advance(HEAVY_MS);
  await s.service.settle();
  const after = (await s.get('/api/platforms/instagram/insights?period=30')).json();
  assert.equal(after.views.total.value, 5);
  assert.equal(after.updatedAt !== null, true);
  assert.equal(after.loading, undefined);
});

test('démarrage à chaud (cache restauré) : réponse immédiate stale, léger revalidé AVANT le lourd', async () => {
  const a = await setup({ persist: true });
  await timedGet(a, '/api/platforms/instagram/stats');
  await a.clock.advance(HEAVY_MS);
  await a.service.settle();
  await a.service.flushCache();
  a.clock.t += 2 * 3_600_000; // redémarrage 2 h plus tard : données périmées
  const b = await setup({ persist: true, cfg: a.cfg, tokens: false });
  b.clock.t = a.clock.t;
  const order = [];
  b.ig.fetchLight = async () => { order.push('light'); await sleep(b.clock, LIGHT_MS); return { partial: true, account: instagramRaw(b.clock.now()).account, followers: 2200, posts: [] }; };
  b.ig.fetchData = async () => { order.push('heavy'); await sleep(b.clock, HEAVY_MS); return instagramRaw(b.clock.now()); };
  await b.store.setToken('instagram', tok(b.clock));
  const restored = await b.service.hydrate();
  assert.ok(restored.restored.includes('instagram'));
  const { res, ms } = await timedGet(b, '/api/platforms/instagram/stats');
  assert.equal(ms, 0, 'réponse immédiate (aucune attente du fournisseur)');
  assert.equal(res.json().stale, true);
  assert.equal(res.json().refreshing, true);
  await b.clock.advance(HEAVY_MS + LIGHT_MS + 100);
  await b.service.settle();
  assert.deepEqual(order, ['light', 'heavy'], 'léger puis lourd');
});

test('paliers actifs/inactifs inchangés : sans présence aucun appel, LinkedIn jamais ordonnancé', async () => {
  const s = await setup();
  s.scheduler.start();
  await s.clock.advance(3_600_000);
  assert.equal(s.calls.light + s.calls.heavy + s.calls.tiktok + s.calls.linkedin, 0);
  assert.ok(!LIVE_PLATFORMS.includes('linkedin'));
  s.scheduler.stop();
});
