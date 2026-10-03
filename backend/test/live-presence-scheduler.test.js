// Mode en direct : présence, battement /api/live/ping, ordonnanceur (horloge simulée, aucun réseau).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeApp, login, stubProvider, FakeClock } from './helpers.js';
import { Presence } from '../src/presence.js';
import { Scheduler, LIVE_PLATFORMS, JITTER } from '../src/scheduler.js';
import { ProviderError } from '../src/http.js';
import { tiktokRaw, instagramRaw, linkedinRaw, DAY } from './integration-fixtures.js';

const ORIGIN = 'https://dash.example.test';
const tok = (clock, extra = {}) => ({ accessToken: 'tok-test', refreshToken: 'rft-test', expiresAt: clock.now() + 20 * DAY, ...extra });

// ------------------------------------------------------------------------------------------ Présence
test('présence : inactive au départ, active pendant la fenêtre, inactive après, reprise signalée une fois', () => {
  const clock = new FakeClock();
  const p = new Presence({ windowMs: 90_000, now: clock.now });
  let resumes = 0;
  p.onResume(() => resumes++);
  assert.equal(p.active(), false);
  assert.equal(p.touch(), true, 'premier battement = reprise');
  assert.equal(p.active(), true);
  assert.equal(p.touch(), false, 'déjà actif : pas une reprise');
  clock.t += 89_999;
  assert.equal(p.active(), true, 'juste dans la fenêtre');
  clock.t += 2;
  assert.equal(p.active(), false, 'fenêtre écoulée');
  assert.equal(p.snapshot().activeUntil, null);
  assert.equal(p.touch(), true, 'reprise après inactivité');
  assert.equal(resumes, 2);
  assert.equal(p.snapshot().active, true);
  assert.equal(p.snapshot().windowSeconds, 90);
});

test('présence : un écouteur défaillant ne casse pas touch()', () => {
  const p = new Presence({ windowMs: 1000, now: () => 5 });
  p.onResume(() => { throw new Error('boom'); });
  assert.doesNotThrow(() => p.touch());
});

test('/api/live/ping : session + origine + JSON, 204 sans corps, marque la présence', async () => {
  const clock = new FakeClock();
  const ctx = makeApp({ now: clock.now });
  const post = (headers, payload = {}) => ctx.app.inject({ method: 'POST', url: '/api/live/ping', headers, payload });
  assert.equal((await post({ origin: ORIGIN })).statusCode, 401, 'sans session');
  assert.equal(ctx.presence.active(), false, 'une requête refusée ne vaut pas présence');
  const cookie = await login(ctx.app);
  assert.equal((await post({ cookie, origin: 'https://evil.example.com' })).statusCode, 403, 'origine étrangère');
  assert.equal((await post({ cookie, 'sec-fetch-site': 'cross-site' })).statusCode, 403);
  assert.equal(ctx.presence.active(), false);
  const ok = await post({ cookie, origin: ORIGIN });
  assert.equal(ok.statusCode, 204);
  assert.equal(ok.body, '');
  assert.equal(ctx.presence.active(), true);
  assert.equal((await ctx.app.inject({ url: '/api/live/ping', headers: { cookie } })).statusCode, 404, 'GET refusé');
  assert.equal(ok.headers['cache-control'], 'no-store');
});

test('présence : une requête authentifiée vers une route de données suffit ; /api/health et auth ne comptent pas', async () => {
  const clock = new FakeClock();
  const ctx = makeApp({ now: clock.now });
  await ctx.app.inject({ url: '/api/health' });
  await ctx.app.inject({ url: '/api/auth/session' });
  assert.equal(ctx.presence.active(), false);
  const cookie = await login(ctx.app);
  assert.equal(ctx.presence.active(), false, 'la connexion seule ne vaut pas utilisation');
  await ctx.app.inject({ url: '/api/status', headers: { cookie } });
  assert.equal(ctx.presence.active(), true);
  clock.t += 91_000;
  assert.equal(ctx.presence.active(), false);
  await ctx.app.inject({ url: '/api/overview', headers: { cookie: await login(ctx.app) } });
  assert.equal(ctx.presence.active(), true);
  const st = (await ctx.app.inject({ url: '/api/status', headers: { cookie: await login(ctx.app) } })).json();
  assert.equal(st.live.active, true);
  assert.equal(st.live.windowSeconds, 90);
});

// ------------------------------------------------------------------------------------------ Ordonnanceur
async function liveSetup({ platforms = ['tiktok', 'instagram'], env = {}, random = () => 0.5, igRaw, ttRaw } = {}) {
  const clock = new FakeClock();
  const calls = { tiktok: { light: 0, heavy: 0 }, instagram: { light: 0, heavy: 0 }, linkedin: { light: 0, heavy: 0 } };
  const lightOf = (p, raw) => async () => {
    calls[p].light++;
    const r = raw(clock.now());
    return { partial: true, account: r.account, followers: r.followers + calls[p].light, posts: r.posts.map(({ ...x }) => x), details: { profile: { followerCount: r.followers } } };
  };
  const mk = (p, raw, withLight = true) => {
    const prov = stubProvider(p, () => { calls[p].heavy++; return raw(clock.now()); }, withLight ? { fetchLight: lightOf(p, raw), heavyPostKeys: [] } : {});
    return prov;
  };
  const providers = {
    tiktok: mk('tiktok', ttRaw || tiktokRaw),
    instagram: mk('instagram', igRaw || instagramRaw),
    linkedin: mk('linkedin', linkedinRaw, false)
  };
  const ctx = makeApp({ providers, now: clock.now, env: { LINKEDIN_COMMUNITY_API: 'true', LINKEDIN_ORGANIZATION_ID: '1', ...env } });
  for (const p of platforms) await ctx.store.setToken(p, tok(clock));
  const scheduler = new Scheduler({ service: ctx.service, presence: ctx.presence, cfg: ctx.cfg, now: clock.now, setTimer: clock.setTimeout, clearTimer: clock.clearTimeout, random });
  return { ...ctx, clock, calls, scheduler, providers };
}
const total = (c) => c.light + c.heavy;

test('ordonnanceur : sans présence, aucun appel fournisseur et aucun timer, même au bout d\'une heure', async () => {
  const s = await liveSetup({ platforms: ['tiktok', 'instagram', 'linkedin'] });
  s.scheduler.start();
  await s.clock.advance(3_600_000);
  assert.equal(total(s.calls.tiktok) + total(s.calls.instagram) + total(s.calls.linkedin), 0);
  assert.equal(s.clock.timers.length, 0);
});

test('ordonnanceur : palier léger toutes les 60 s (Instagram) / 90 s (TikTok), lourd toutes les 900 s, jamais LinkedIn', async () => {
  const s = await liveSetup({ platforms: ['tiktok', 'instagram', 'linkedin'] });
  s.scheduler.start();
  const beat = async (seconds) => { for (let i = 0; i < seconds / 30; i++) { s.presence.touch(); await s.clock.advance(30_000); } };
  await beat(600);
  // reprise : premier cycle à froid = léger PUIS lourd, puis un léger toutes les 60 s / 90 s
  assert.deepEqual([s.calls.instagram.heavy, s.calls.instagram.light], [1, 11], 'Instagram : 600 s -> 10 paliers légers');
  assert.deepEqual([s.calls.tiktok.heavy, s.calls.tiktok.light], [1, 7], 'TikTok : 600 s -> 6 paliers légers');
  await beat(330); // 930 s : palier lourd échu à 900 s
  assert.equal(s.calls.instagram.heavy, 2);
  assert.equal(s.calls.tiktok.heavy, 2);
  assert.equal(total(s.calls.linkedin), 0, 'LinkedIn n\'est jamais accéléré ni sondé');
  assert.ok(!LIVE_PLATFORMS.includes('linkedin'));
  // le jeu fusionné contient bien les données légères ET lourdes
  const raw = s.service.currentRaw('instagram');
  assert.equal(raw.posts.length, 2);
});

test('ordonnanceur : jitter borné à ±10 % de l\'intervalle', async () => {
  for (const [rnd, expected] of [[0, 54_000], [1, 66_000], [0.5, 60_000]]) {
    const s = await liveSetup({ platforms: ['instagram'], random: () => rnd });
    s.scheduler.start();
    s.presence.touch();
    await s.clock.advance(0); // reprise : cycle lourd immédiat (aucune donnée)
    await s.clock.flush();
    assert.ok(s.clock.timers.length >= 1);
    const delay = Math.min(...s.clock.timers.map((t) => t.at - s.clock.now())); // TikTok (non connecté) : simple revérification locale, 90 s
    assert.ok(Math.abs(delay - expected) <= 1, `jitter ${rnd} : ${delay} ≠ ${expected}`);
    assert.ok(delay >= 60_000 * (1 - JITTER) - 1 && delay <= 60_000 * (1 + JITTER) + 1);
  }
});

test('ordonnanceur : s\'arrête dès que la présence tombe, reprend au premier battement (léger immédiat si échu)', async () => {
  const s = await liveSetup({ platforms: ['instagram'] });
  s.scheduler.start();
  s.presence.touch();
  await s.clock.advance(125_000); // heavy (t=0) + lights à 60 s, 120 s ; la présence expire à 90 s
  const after = total(s.calls.instagram);
  assert.ok(after >= 2 && after <= 3, `appels pendant la présence : ${after}`);
  await s.clock.advance(600_000);
  assert.equal(total(s.calls.instagram), after, 'aucun appel sans présence');
  assert.equal(s.clock.timers.length, 0, 'aucun timer ne reste armé');
  s.presence.touch(); // reprise après 10 min d'inactivité : léger échu -> immédiat
  await s.clock.flush();
  assert.equal(total(s.calls.instagram), after + 1, 'rafraîchissement immédiat à la reprise');
});

test('ordonnanceur : reprise immédiate seulement si les données sont plus vieilles que l\'intervalle léger', async () => {
  const s = await liveSetup({ platforms: ['instagram'] });
  s.scheduler.start();
  s.presence.touch();
  await s.clock.advance(100_000); // heavy à 0, léger à 60 s ; la présence expire à 90 s
  const base = total(s.calls.instagram);
  assert.equal(base, 3, 'à froid : léger + lourd, puis un léger à 60 s');
  await s.clock.advance(30_000); // le timer de 120 s constate l'absence et se range
  assert.equal(total(s.calls.instagram), base);
  s.presence.touch(); // données de ~70 s > 60 s : échues -> rafraîchissement immédiat
  await s.clock.flush();
  assert.equal(total(s.calls.instagram), base + 1);
  // reprise alors que les données ont 20 s : aucun appel inutile
  await s.clock.advance(200_000);
  const before = total(s.calls.instagram);
  s.service.slots.instagram.lightAt = s.clock.now() - 20_000;
  s.presence.touch();
  await s.clock.flush();
  assert.equal(total(s.calls.instagram), before, 'données récentes : pas d\'appel immédiat');
});

test('ordonnanceur : jamais pour une plateforme non connectée, en attente d\'approbation ou au jeton expiré', async () => {
  const s = await liveSetup({ platforms: ['tiktok', 'instagram'] });
  s.providers.instagram.pendingApproval = true; // « approbation » : jamais d'appel
  await s.store.setToken('tiktok', tok(s.clock, { expiresAt: s.clock.now() - 1000 })); // expiré
  s.scheduler.start();
  for (let i = 0; i < 20; i++) { s.presence.touch(); await s.clock.advance(30_000); }
  assert.equal(total(s.calls.instagram), 0, 'pending');
  assert.equal(total(s.calls.tiktok), 0, 'jeton expiré');
  const none = await liveSetup({ platforms: [] });
  none.scheduler.start();
  for (let i = 0; i < 10; i++) { none.presence.touch(); await none.clock.advance(30_000); }
  assert.equal(total(none.calls.instagram) + total(none.calls.tiktok), 0, 'non connectée');
});

test('ordonnanceur : un seul cycle à la fois par plateforme', async () => {
  const s = await liveSetup({ platforms: ['instagram'] });
  let release;
  const gate = new Promise((r) => { release = r; });
  let started = 0;
  s.providers.instagram.fetchData = async () => { started++; await gate; return instagramRaw(s.clock.now()); };
  s.scheduler.started = true;
  s.presence.touch();
  const a = s.scheduler.cycle('instagram');
  const b = s.scheduler.cycle('instagram');
  await s.clock.flush();
  assert.equal(started, 1, 'le second cycle est ignoré tant que le premier tourne');
  release();
  await Promise.all([a, b]);
  assert.equal(started, 1);
  s.scheduler.stop();
});

test('ordonnanceur : erreur / 429 -> backoff exponentiel (pas de boucle serrée)', async () => {
  const s = await liveSetup({ platforms: ['instagram'] });
  await s.service.runTier('instagram', 'heavy'); // jeu initial
  let n = 0;
  s.providers.instagram.fetchLight = async () => { n++; throw new ProviderError('instagram', 'rate_limit', 'limite', 429); };
  s.scheduler.start();
  const beat = async (seconds) => { for (let i = 0; i < seconds / 10; i++) { s.presence.touch(); await s.clock.advance(10_000); } };
  await beat(70);
  assert.equal(n, 1, '1re tentative à ~60 s');
  await beat(100); // prochaine tentative >= 2 x 60 s après la première
  assert.equal(n, 1);
  await beat(60);
  assert.equal(n, 2, '2e tentative après 120 s');
  await beat(130);
  assert.equal(n, 2, 'intervalle suivant : 240 s');
  s.scheduler.stop();
});

test('ordonnanceur : quota Meta observé > 70 % -> cadence divisée par deux', async () => {
  const s = await liveSetup({ platforms: ['instagram'] });
  s.meter.observeUsage('instagram', 75);
  s.scheduler.start();
  for (let i = 0; i < 20; i++) { s.presence.touch(); await s.clock.advance(30_000); } // 600 s
  assert.equal(s.calls.instagram.heavy, 1);
  assert.equal(s.calls.instagram.light, 6, 'un léger (+1 : léger de démarrage à froid)  toutes les 120 s au lieu de 60 s');
  assert.equal(s.service.quotaOf('instagram').slowdownFactor, 2);
  s.scheduler.stop();
});

test('ordonnanceur : arrêt propre (stop) annule les timers et ignore les reprises', async () => {
  const s = await liveSetup({ platforms: ['instagram'] });
  s.scheduler.start();
  s.presence.touch();
  await s.clock.flush();
  assert.ok(s.clock.timers.length >= 1);
  s.scheduler.stop();
  assert.equal(s.clock.timers.length, 0);
  const before = total(s.calls.instagram);
  s.clock.t += 200_000;
  s.presence.touch();
  await s.clock.advance(300_000);
  assert.equal(total(s.calls.instagram), before);
});

test('ordonnanceur : LIVE_ENABLED=false ne démarre rien', async () => {
  const s = await liveSetup({ env: { LIVE_ENABLED: 'false' } });
  s.scheduler.start();
  s.presence.touch();
  await s.clock.advance(600_000);
  assert.equal(total(s.calls.instagram) + total(s.calls.tiktok), 0);
});
