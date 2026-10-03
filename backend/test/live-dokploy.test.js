// GET /api/infrastructure/live : forme, null ≠ 0, débits réseau, coalescence, hint, secrets, auth/origine, rate-limit isolé.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DokployClient } from '../src/dokploy.js';
import { networkRate, HINT } from '../src/dokploy-live.js';
import { fakeFetch, makeApp, login, FakeClock } from './helpers.js';

const ORIGIN = 'https://dash.example.test';
const T0 = Date.parse('2026-10-01T10:00:00Z');
const iso = (t) => new Date(t).toISOString();
const GIB_OK = (v) => Math.abs(v) < 1e-9;

/**
 * Faux Dokploy : métriques (points fournis par `points()`), projets avec statuts, déploiements.
 * `calls` compte les appels par route : c'est la mesure de la charge réelle sur Dokploy.
 */
function fixture({ clock = new FakeClock(T0), points, appStatus = 'done', deployments = {}, token = 'METRICS_SECRET', projectStatus = 200, metricsStatus = 200, tokenBody } = {}) {
  const calls = {};
  const hit = (k) => { calls[k] = (calls[k] || 0) + 1; };
  const defaultPoints = () => [
    { cpu: '24.00', memUsedGB: '3.20', memTotal: '8.00', totalDisk: '80.00', diskUsed: '52.50', uptime: 123456, networkIn: '100.00', networkOut: '50.00', timestamp: iso(clock.now() - 62_000) },
    { cpu: '24.00', memUsedGB: '3.20', memTotal: '8.00', totalDisk: '80.00', diskUsed: '52.50', uptime: 123518, networkIn: '700.00', networkOut: '80.00', timestamp: iso(clock.now() - 2_000) }
  ];
  const project = { projectId: 'p', name: 'Projet', env: 'TOP_SECRET_ENV', environments: [{ applications: [{ applicationId: 'a', name: 'API', applicationStatus: appStatus, env: 'TOP_SECRET_ENV' }, { applicationId: 'b', name: 'Web', applicationStatus: 'done' }], compose: [{ composeId: 'c', name: 'Compose', composeStatus: 'done' }], postgres: [{ postgresId: 'db', name: 'Postgres', applicationStatus: 'done' }] }] };
  const idOf = (url, key) => new URL(url).searchParams.get(key);
  const fetch = fakeFetch([
    [/settings.getDokployVersion/, () => ({ json: 'v0.30.8' })],
    [/project.all/, () => { hit('project.all'); return projectStatus === 200 ? { json: [project] } : { status: projectStatus, json: { message: 'nope' } }; }],
    [/project.one/, () => { hit('project.one'); return { json: project }; }],
    [/deployment.allByCompose/, (url) => { hit('deployment.allByCompose'); return { json: deployments[idOf(url, 'composeId')] || [] }; }],
    [/deployment.all/, (url) => { hit(`deployment.all:${idOf(url, 'applicationId')}`); return { json: deployments[idOf(url, 'applicationId')] || [] }; }],
    [/user.getMetricsToken/, () => { hit('user.getMetricsToken'); return { json: tokenBody ?? { serverIp: '127.0.0.1', metricsConfig: { server: { port: 4500, token } } } }; }],
    [/server.getServerMetrics/, (url) => { hit('server.getServerMetrics'); assert.equal(new URL(url).searchParams.get('dataPoints'), '2', 'peu de points demandés'); return metricsStatus === 200 ? { json: (points || defaultPoints)() } : { status: metricsStatus, json: { message: 'Error 401' } }; }]
  ]);
  const client = new DokployClient({ url: 'https://dokploy.example.test', apiKey: 'API_SECRET' }, { fetch, now: clock.now });
  return { client, fetch, calls, clock };
}

async function app(fx, env = {}) {
  const ctx = makeApp({ dokploy: fx.client, now: fx.clock.now, env });
  ctx.cookie = await login(ctx.app);
  ctx.get = (url = '/api/infrastructure/live') => ctx.app.inject({ url, headers: { cookie: ctx.cookie } });
  return ctx;
}

test('live : forme exacte, unités GiB, pourcentages, débits réseau issus des compteurs cumulés', async () => {
  const fx = fixture();
  const ctx = await app(fx);
  const r = await ctx.get();
  assert.equal(r.statusCode, 200);
  const b = r.json();
  assert.deepEqual(Object.keys(b).sort(), ['changedAt', 'connection', 'observedAt', 'runningDeployments', 'server', 'services']);
  assert.deepEqual(b.connection, { status: 'connected', reason: null });
  assert.equal(b.observedAt, iso(T0));
  const s = b.server;
  assert.deepEqual(Object.keys(s).sort(), ['cpuPercent', 'diskPercent', 'diskTotalGiB', 'diskUsedGiB', 'hint', 'memoryPercent', 'memoryTotalGiB', 'memoryUsedGiB', 'message', 'networkInMbps', 'networkOutMbps', 'reason', 'sampleAgeSeconds', 'sampleAt', 'sampleIntervalSeconds', 'status', 'uptimeSeconds']);
  assert.equal(s.status, 'available');
  assert.equal(s.cpuPercent, 24);
  assert.equal(s.memoryUsedGiB, 3.2);
  assert.equal(s.memoryTotalGiB, 8);
  assert.equal(s.memoryPercent, 40);
  assert.equal(s.diskTotalGiB, 80);
  assert.equal(s.diskUsedGiB, 42);
  assert.equal(s.diskPercent, 52.5);
  assert.equal(s.uptimeSeconds, 123518);
  assert.equal(s.sampleAt, iso(T0 - 2_000));
  assert.equal(s.sampleAgeSeconds, 2);
  // 600 MiB en 60 s = 600 x 8,388608 / 60 = 83,89 Mbit/s ; 30 MiB en 60 s = 4,19 Mbit/s
  assert.equal(s.networkInMbps, 83.89);
  assert.equal(s.networkOutMbps, 4.19);
  assert.equal(s.sampleIntervalSeconds, 60);
  assert.equal(s.hint, HINT);
  assert.match(s.hint, /minimum 2 s/);
  assert.deepEqual(b.services.map((x) => `${x.type}:${x.id}:${x.status}`), ['application:a:done', 'application:b:done', 'compose:c:done', 'postgres:db:done']);
  assert.deepEqual(Object.keys(b.services[0]).sort(), ['id', 'status', 'type'], 'services : id, type, statut uniquement');
  assert.deepEqual(b.runningDeployments, []);
  assert.equal(b.changedAt, iso(T0));
  assert.equal(r.headers['cache-control'], 'no-store');
  assert.match(r.headers['server-timing'], /dokploy;dur=/);
  assert.ok(JSON.stringify(b).length < 2000, 'charge utile petite');
});

test('live : débit réseau = null (jamais inventé) avec un seul point, compteur en régression ou horodatages égaux ; null ≠ 0', async () => {
  const clock = new FakeClock(T0);
  const one = await app(fixture({ clock, points: () => [{ cpu: 0, memUsedGB: 1, memTotal: 4, totalDisk: 10, diskUsed: 0, networkIn: '10', networkOut: '0', timestamp: iso(clock.now() - 1000) }] }));
  const a = (await one.get()).json().server;
  assert.equal(a.networkInMbps, null);
  assert.equal(a.networkOutMbps, null);
  assert.equal(a.uptimeSeconds, null, 'uptime absent = null');
  assert.equal(a.sampleIntervalSeconds, null, 'un seul point : intervalle inconnu');
  assert.equal(a.hint, null);
  assert.equal(a.cpuPercent, 0, 'un CPU réellement à 0 reste 0');
  assert.equal(a.diskPercent, 0);
  assert.equal(a.diskUsedGiB, 0);

  const reg = await app(fixture({ clock, points: () => [
    { cpu: 5, memUsedGB: 1, memTotal: 4, totalDisk: 10, diskUsed: 5, networkIn: '900', networkOut: '50', timestamp: iso(clock.now() - 11_000) },
    { cpu: 5, memUsedGB: 1, memTotal: 4, totalDisk: 10, diskUsed: 5, networkIn: '20', networkOut: '60', timestamp: iso(clock.now() - 1_000) }
  ] }));
  const b = (await reg.get()).json().server;
  assert.equal(b.networkInMbps, null, 'compteur régressé (redémarrage) : pas de débit négatif');
  assert.equal(b.networkOutMbps, 8.39, '10 MiB en 10 s = 1 MiB/s');

  const missing = await app(fixture({ clock, points: () => [{ cpu: 'abc', memTotal: '4', timestamp: iso(clock.now() - 1000) }, { memTotal: '4', memUsedGB: null, totalDisk: 10, timestamp: iso(clock.now()) }] }));
  const c = (await missing.get()).json().server;
  assert.equal(c.cpuPercent, null);
  assert.equal(c.memoryUsedGiB, null);
  assert.equal(c.memoryPercent, null, 'pourcentage indéterminable = null');
  assert.equal(c.diskPercent, null);

  assert.equal(networkRate({ timestamp: iso(T0), networkIn: 1 }, { timestamp: iso(T0), networkIn: 5 }, 'networkIn'), null, 'même horodatage');
  assert.equal(networkRate(null, { timestamp: iso(T0) }, 'networkIn'), null);
  assert.equal(networkRate({ timestamp: iso(T0), networkIn: 'x' }, { timestamp: iso(T0 + 1000), networkIn: 5 }, 'networkIn'), null);
});

test('live : intervalle estimé par l\'écart médian entre échantillons ; hint seulement au-delà de 10 s', async () => {
  const clock = new FakeClock(T0);
  let step = 0;
  const fx = fixture({ clock, points: () => {
    step++;
    const t = clock.now();
    return [{ cpu: 1, memUsedGB: 1, memTotal: 4, totalDisk: 10, diskUsed: 1, networkIn: String(step), networkOut: '0', timestamp: iso(t - 2000) }, { cpu: 1, memUsedGB: 1, memTotal: 4, totalDisk: 10, diskUsed: 1, networkIn: String(step + 1), networkOut: '0', timestamp: iso(t) }];
  } });
  const ctx = await app(fx);
  let last;
  for (let i = 0; i < 4; i++) { clock.t += 2100; last = (await ctx.get()).json().server; }
  assert.equal(last.sampleIntervalSeconds, 2);
  assert.equal(last.hint, null, '2 s <= 10 s : pas de conseil');
  assert.equal(last.sampleAgeSeconds, 0);

  const slow = await app(fixture({ clock: new FakeClock(T0) })); // points à 60 s d'écart
  const s = (await slow.get()).json().server;
  assert.equal(s.sampleIntervalSeconds, 60);
  assert.equal(s.hint, 'Pour des mesures plus fréquentes, réduisez l’intervalle de rafraîchissement du monitoring dans Dokploy (minimum 2 s).');
});

test('live : coalescence — 20 requêtes simultanées = un seul appel Dokploy par composant, TTL 2 s / 5 s / 3 s', async () => {
  const clock = new FakeClock(T0);
  const fx = fixture({ clock, appStatus: 'running', deployments: { a: [{ deploymentId: 'dep-1', status: 'running', createdAt: iso(T0) }] } });
  const ctx = await app(fx);
  const rs = await Promise.all(Array.from({ length: 20 }, () => ctx.get()));
  assert.ok(rs.every((r) => r.statusCode === 200));
  assert.deepEqual(rs.map((r) => r.json().runningDeployments), Array(20).fill(['dep-1']));
  assert.equal(fx.calls['user.getMetricsToken'], 1);
  assert.equal(fx.calls['server.getServerMetrics'], 1);
  assert.equal(fx.calls['project.all'], 1);
  assert.equal(fx.calls['deployment.all:a'], 1, 'lecture ciblée du seul service en cours');
  assert.equal(fx.calls['deployment.all:b'], undefined);
  assert.equal(fx.calls['project.one'], undefined, 'pas de relance complète N+1');
  assert.equal(fx.calls['deployment.allByCompose'], undefined);
  const after = () => ({ m: fx.calls['server.getServerMetrics'], s: fx.calls['project.all'], d: fx.calls['deployment.all:a'] });
  await ctx.get(); await ctx.get();
  assert.deepEqual(after(), { m: 1, s: 1, d: 1 }, 'dans les TTL : aucun nouvel appel');
  clock.t += 2100; await Promise.all([ctx.get(), ctx.get(), ctx.get()]);
  assert.deepEqual(after(), { m: 2, s: 1, d: 1 }, 'métriques relues après 2 s, statuts toujours en cache (5 s)');
  assert.equal(fx.calls['user.getMetricsToken'], 1, 'configuration du monitoring mise en cache (jeton jamais exposé)');
  clock.t += 1000; await ctx.get(); // 3,1 s : déploiements en cours relus
  assert.equal(after().d, 2);
  clock.t += 2000; await ctx.get(); // 5,1 s : statuts relus
  assert.equal(after().s, 2);
});

test('live : déploiements en cours — aucune lecture quand aucun service n\'est « running »', async () => {
  const fx = fixture();
  const ctx = await app(fx);
  assert.deepEqual((await ctx.get()).json().runningDeployments, []);
  assert.ok(!Object.keys(fx.calls).some((k) => k.startsWith('deployment.')), 'aucun appel deployment.*');
});

test('live : changedAt n\'avance que lorsque les statuts ou déploiements en cours changent', async () => {
  const clock = new FakeClock(T0);
  const fx = fixture({ clock });
  const ctx = await app(fx);
  const first = (await ctx.get()).json();
  clock.t += 6000;
  const same = (await ctx.get()).json();
  assert.equal(same.changedAt, first.changedAt);
  // le service passe en déploiement
  const fx2 = fixture({ clock, appStatus: 'running' });
  ctx.app.dokploy.fetch = fx2.client.fetch;
  clock.t += 6000;
  const changed = (await ctx.get()).json();
  assert.equal(changed.services.find((s) => s.id === 'a').status, 'running');
  assert.equal(changed.changedAt, iso(clock.now()));
});

test('live : aucun secret (clé API, jeton de monitoring, variables d\'environnement, en-têtes)', async () => {
  const fx = fixture({ appStatus: 'running', deployments: { a: [{ deploymentId: 'dep-1', status: 'running', createdAt: iso(T0), errorMessage: 'secret=ABCDEF', logPath: '/etc/dokploy/logs/x.log' }] } });
  const ctx = await app(fx);
  const r = await ctx.get();
  for (const secret of ['METRICS_SECRET', 'API_SECRET', 'TOP_SECRET_ENV', 'x-api-key', 'ABCDEF', '/etc/dokploy', '127.0.0.1', '4500']) {
    assert.ok(!r.body.includes(secret), `${secret} exposé`);
  }
  assert.ok(!JSON.stringify(r.headers).includes('SECRET'));
});

test('live : états de monitoring conservés, distincts de la connexion à l\'API', async () => {
  const notConf = (await (await app(fixture({ token: '', tokenBody: { serverIp: '127.0.0.1', metricsConfig: { server: { port: 4500, token: '', urlCallback: '' } } } }))).get()).json();
  assert.equal(notConf.connection.status, 'connected', 'l\'API répond');
  assert.equal(notConf.server.status, 'not_configured');
  assert.equal(notConf.server.reason, 'token_and_callback_empty');
  assert.equal(notConf.server.cpuPercent, null);
  assert.equal(notConf.server.memoryUsedGiB, null);
  assert.match(notConf.server.message, /Monitoring non configuré/);

  const denied = (await (await app(fixture({ projectStatus: 401 }))).get()).json();
  assert.deepEqual(denied.connection, { status: 'error', reason: 'auth' });
  assert.equal(denied.server.status, 'available', 'le monitoring reste lisible : distinction connexion / monitoring');

  const agentDown = (await (await app(fixture({ metricsStatus: 500 }))).get()).json();
  assert.equal(agentDown.connection.status, 'connected');
  assert.notEqual(agentDown.server.status, 'available');
  assert.equal(agentDown.server.cpuPercent, null);

  const stale = (await (await app(fixture({ clock: new FakeClock(T0), points: () => [{ cpu: 5, memUsedGB: 1, memTotal: 4, totalDisk: 10, diskUsed: 5, timestamp: iso(T0 - 10 * 60_000) }] }))).get()).json();
  assert.equal(stale.server.status, 'stale');
  assert.equal(stale.server.sampleAgeSeconds, 600);
});

test('live : Dokploy non configuré -> état explicite, aucun appel', async () => {
  const fetch = fakeFetch([]);
  const client = new DokployClient({ url: '', apiKey: '' }, { fetch });
  const ctx = makeApp({ dokploy: client });
  const cookie = await login(ctx.app);
  const b = (await ctx.app.inject({ url: '/api/infrastructure/live', headers: { cookie } })).json();
  assert.deepEqual(b.connection, { status: 'not_configured', reason: 'configuration' });
  assert.deepEqual(b.services, []);
  assert.equal(b.server.cpuPercent, null);
  assert.equal(fetch.calls.length, 0);
});

test('live : aucune interrogation de fond — Dokploy n\'est appelé que lorsque la route est sollicitée', async () => {
  const clock = new FakeClock(T0);
  const fx = fixture({ clock });
  const ctx = await app(fx);
  ctx.presence.touch();
  await clock.advance(10 * 60_000);
  assert.equal(fx.fetch.calls.length, 0);
  assert.equal(clock.timers.length, 0);
});

test('live : session obligatoire, GET uniquement, origine contrôlée pour toute méthode modifiante', async () => {
  const ctx = await app(fixture());
  assert.equal((await ctx.app.inject({ url: '/api/infrastructure/live' })).statusCode, 401);
  assert.equal((await ctx.app.inject({ url: '/api/infrastructure/live', headers: { cookie: 'sd_session=forge' } })).statusCode, 401);
  const post = (headers) => ctx.app.inject({ method: 'POST', url: '/api/infrastructure/live', headers: { cookie: ctx.cookie, ...headers }, payload: {} });
  assert.equal((await post({ origin: 'https://evil.example.com' })).statusCode, 403);
  assert.equal((await post({ origin: ORIGIN })).statusCode, 404, 'aucune méthode d\'écriture sur cette route');
  assert.equal((await ctx.get()).statusCode, 200);
});

test('live : rate limit isolé (bucket dédié) — ne consomme pas le quota des autres routes /api/infrastructure*', async () => {
  const clock = new FakeClock(T0);
  const ctx = await app(fixture({ clock }), { LIVE_RATE_LIMIT_PER_MINUTE: '90' });
  assert.equal(ctx.cfg.live.rateLimitPerMinute, 90);
  // 80 appels live : aucun 429, et le quota de 30/min des routes infrastructure reste intact
  const live = [];
  for (let i = 0; i < 80; i++) live.push((await ctx.get()).statusCode);
  assert.ok(live.every((c) => c === 200));
  const infra = [];
  for (let i = 0; i < 30; i++) infra.push((await ctx.get('/api/infrastructure')).statusCode);
  assert.ok(infra.every((c) => c === 200), 'quota infrastructure intact après 80 appels live');
  const blocked = await ctx.get('/api/infrastructure');
  assert.equal(blocked.statusCode, 429, 'les autres routes gardent leur limite de 30/min');
  assert.ok(blocked.headers['retry-after']);
  // l'épuisement du quota infrastructure ne bloque pas /live
  assert.equal((await ctx.get()).statusCode, 200);
  for (let i = 0; i < 9; i++) await ctx.get();
  const over = await ctx.get(); // 91e appel live de la minute
  assert.equal(over.statusCode, 429);
  assert.equal(over.json().error, 'too_many_requests');
  assert.equal((await ctx.get('/api/deployments/x/logs')).statusCode === 429, true, 'logs : toujours sur le bucket infrastructure');
  clock.t += 61_000;
  assert.equal((await ctx.get()).statusCode, 200, 'fenêtre d\'une minute écoulée');
});

test('live : /api/infrastructure (snapshot complet) inchangé et distinct', async () => {
  const fx = fixture();
  const ctx = await app(fx);
  const snap = (await ctx.get('/api/infrastructure')).json();
  assert.equal(snap.status, 'connected');
  assert.ok(Array.isArray(snap.deployments));
  assert.equal(snap.server.scope, 'vps');
  const live = (await ctx.get()).json();
  assert.equal(live.server.scope, undefined);
});
