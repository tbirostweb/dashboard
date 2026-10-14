// Deux VPS : configuration, isolation des caches et des pannes, ciblage explicite des actions, mesures du serveur distant.
// Aucun appel réseau réel : faux fetch uniquement ; aucune action sur la production.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DokployClient } from '../src/dokploy.js';
import { loadConfig, assertSecrets, ConfigError } from '../src/config.js';
import { fakeFetch, makeApp, login, testConfig } from './helpers.js';

const NOW = Date.parse('2026-10-01T00:00:00Z');
const project = (id, appId, name) => [{ projectId: id, name, environments: [{ environmentId: `e-${id}`, name: 'production', applications: [{ applicationId: appId, name: 'site', appName: `site-${id}`, applicationStatus: 'done' }] }] }];
const q = (url, key) => new URL(url).searchParams.get(key);

/** Faux Dokploy d'un VPS : projets, déploiements, redéploiement ; `down` simule une panne ; remote = mesures via server.one. */
function fakeDokploy({ projectId, appId, name, down = false, remote = false }) {
  const redeploys = [];
  const gone = () => ({ status: 503, json: { message: 'panne' } });
  const routes = [
    [/settings.getDokployVersion/, () => (down ? gone() : { json: 'v0.30.8' })],
    [/project.all/, () => (down ? gone() : { json: project(projectId, appId, name) })],
    [/project.one/, (url) => ({ json: project(projectId, appId, name).find((p) => p.projectId === q(url, 'projectId')) })],
    [/deployment.allByCompose/, () => ({ json: [] })],
    [/deployment.all/, () => ({ json: [{ deploymentId: `d-${appId}`, status: 'done', createdAt: '2026-09-30T10:00:00Z' }] })],
    [/server.one/, () => ({ json: { ipAddress: '203.0.113.7', metricsConfig: { server: { port: 4500, token: 'METRICS_SECRET' } } } })],
    [/user.getMetricsToken/, () => (remote ? { status: 500, json: { message: 'ne doit pas être appelé' } } : { json: { serverIp: '127.0.0.1', metricsConfig: { server: { port: 4500, token: 'METRICS_SECRET' } } } })],
    [/server.getServerMetrics/, () => ({ json: [{ cpu: '10.00', memUsedGB: '1.00', memTotal: '4.00', totalDisk: '40.00', diskUsed: '25.00', timestamp: '2026-09-30T23:58:00Z' }] })],
    [/application.redeploy/, (url, init) => { redeploys.push(JSON.parse(init.body).applicationId); return { body: '' }; }]
  ];
  const fetch = fakeFetch(routes);
  return { fetch, redeploys };
}
const client = (url, fetch, extra = {}) => new DokployClient({ url, apiKey: 'API_SECRET_1', actionAllowlist: ['p1', 'p2'], ...extra }, { fetch, now: () => NOW });

function twoVps({ down2 = false } = {}) {
  const a = fakeDokploy({ projectId: 'p1', appId: 'a1', name: 'Alpha' });
  const b = fakeDokploy({ projectId: 'p2', appId: 'a2', name: 'Beta', down: down2, remote: true });
  const c1 = client('https://dokploy.example.test', a.fetch), c2 = client('https://dokploy.example.test', b.fetch, { serverId: 'srv-2', apiKey: 'API_SECRET_2' });
  const { app } = makeApp({ dokploy: c1, dokployExtra: [{ id: 'vps-2', name: 'VPS 2', client: c2 }] });
  return { app, a, b, c1, c2 };
}

test('configuration : DOKPLOY2_* actif seulement s’il est complet, liste blanche et clé distinctes obligatoires', () => {
  assert.deepEqual(loadConfig({}).dokployExtra, []);
  const cfg = testConfig({ DOKPLOY_URL: 'https://d.example.test', DOKPLOY_API_KEY: 'cle-numero-un-1', DOKPLOY_ACTION_ALLOWLIST: 'p1', DOKPLOY2_URL: 'https://d.example.test', DOKPLOY2_API_KEY: 'cle-numero-deux-2', DOKPLOY2_NAME: 'Mon VPS 2' });
  assert.equal(cfg.dokployExtra[0].name, 'Mon VPS 2');
  assert.equal(cfg.dokploy.name, 'VPS 1');
  assert.throws(() => assertSecrets(cfg), (e) => e instanceof ConfigError && /DOKPLOY2_ACTION_ALLOWLIST/.test(e.message));
  const same = testConfig({ DOKPLOY_URL: 'https://d.example.test', DOKPLOY_API_KEY: 'cle-identique-12', DOKPLOY_ACTION_ALLOWLIST: 'p1', DOKPLOY2_URL: 'https://d.example.test', DOKPLOY2_API_KEY: 'cle-identique-12', DOKPLOY2_ACTION_ALLOWLIST: 'p2' });
  assert.throws(() => assertSecrets(same), /identique/);
  const ok = testConfig({ DOKPLOY_URL: 'https://d.example.test', DOKPLOY_API_KEY: 'cle-numero-un-1', DOKPLOY_ACTION_ALLOWLIST: 'p1', DOKPLOY2_URL: 'https://d.example.test', DOKPLOY2_API_KEY: 'cle-numero-deux-2', DOKPLOY2_ACTION_ALLOWLIST: 'p2' });
  assert.doesNotThrow(() => assertSecrets(ok));
});

test('un seul VPS : routes historiques inchangées, aucune action ne réclame de serveur', async () => {
  const a = fakeDokploy({ projectId: 'p1', appId: 'a1', name: 'Alpha' });
  const { app } = makeApp({ dokploy: client('https://dokploy.example.test', a.fetch) });
  const cookie = await login(app);
  const servers = (await app.inject({ url: '/api/servers', headers: { cookie } })).json().servers;
  assert.deepEqual(servers.map((s) => s.id), ['vps-1']);
  const snap = (await app.inject({ url: '/api/infrastructure', headers: { cookie } })).json();
  assert.equal(snap.services[0].id, 'a1');
  const r = await app.inject({ method: 'POST', url: '/api/infrastructure/services/application/a1/redeploy', headers: { cookie, origin: 'https://dash.example.test' }, payload: { confirmed: true } });
  assert.equal(r.statusCode, 202);
  assert.deepEqual(a.redeploys, ['a1']);
});

test('deux VPS : chaque serveur renvoie SES services, le défaut est le premier, un serveur inconnu est refusé', async () => {
  const { app } = twoVps();
  const cookie = await login(app);
  const get = async (url) => app.inject({ url, headers: { cookie } });
  assert.deepEqual((await get('/api/servers')).json().servers.map((s) => s.name), ['VPS 1', 'VPS 2']);
  assert.equal((await get('/api/infrastructure')).json().services[0].id, 'a1');
  assert.equal((await get('/api/infrastructure?server=vps-1')).json().services[0].id, 'a1');
  assert.equal((await get('/api/infrastructure?server=vps-2')).json().services[0].id, 'a2');
  assert.equal((await get('/api/infrastructure?server=vps-9')).statusCode, 404);
  const all = (await get('/api/infrastructure/all')).json().servers;
  assert.deepEqual(all.map((s) => [s.id, s.services[0].id]), [['vps-1', 'a1'], ['vps-2', 'a2']]);
});

test('panne partielle : le VPS 2 en erreur n’empêche ni son propre affichage d’erreur ni le VPS 1', async () => {
  const { app } = twoVps({ down2: true });
  const cookie = await login(app);
  const all = (await app.inject({ url: '/api/infrastructure/all', headers: { cookie } })).json().servers;
  assert.equal(all[0].status, 'connected');
  assert.equal(all[0].services.length, 1);
  assert.equal(all[1].status, 'error');
  assert.equal(all[1].services.length, 0);
  assert.equal((await app.inject({ url: '/api/infrastructure?server=vps-1', headers: { cookie } })).json().status, 'connected');
});

test('actions : serveur explicite obligatoire avec deux VPS, ciblage exact, liste blanche propre à chaque serveur', async () => {
  const { app, a, b } = twoVps();
  const cookie = await login(app);
  const post = (url) => app.inject({ method: 'POST', url, headers: { cookie, origin: 'https://dash.example.test' }, payload: { confirmed: true } });
  assert.equal((await post('/api/infrastructure/services/application/a2/redeploy')).statusCode, 400, 'sans ?server=');
  // a2 appartient au VPS 2 : demandé au VPS 1, il est introuvable (aucune action n'atteint le mauvais serveur)
  const wrong = await post('/api/infrastructure/services/application/a2/redeploy?server=vps-1');
  assert.ok(wrong.statusCode >= 400);
  assert.deepEqual([a.redeploys, b.redeploys], [[], []]);
  assert.equal((await post('/api/infrastructure/services/application/a2/redeploy?server=vps-2')).statusCode, 202);
  assert.deepEqual([a.redeploys, b.redeploys], [[], ['a2']]);
  assert.equal((await post('/api/infrastructure/services/application/a1/redeploy?server=vps-1')).statusCode, 202);
  assert.deepEqual([a.redeploys, b.redeploys], [['a1'], ['a2']]);
});

test('mesures : le serveur distant lit server.one (jamais user.getMetricsToken), le VPS 1 lit l’hôte', async () => {
  const { app, b, a } = twoVps();
  const cookie = await login(app);
  const s2 = (await app.inject({ url: '/api/infrastructure?server=vps-2', headers: { cookie } })).json().server;
  assert.equal(s2.status, 'available');
  assert.equal(s2.cpuPercent, 10);
  assert.ok(b.fetch.calls.some((c) => /server\.one\?serverId=srv-2/.test(c.url)));
  assert.ok(!b.fetch.calls.some((c) => /getMetricsToken/.test(c.url)));
  const s1 = (await app.inject({ url: '/api/infrastructure?server=vps-1', headers: { cookie } })).json().server;
  assert.equal(s1.status, 'available');
  assert.ok(a.fetch.calls.some((c) => /getMetricsToken/.test(c.url)));
  assert.ok(!JSON.stringify([s1, s2]).includes('METRICS_SECRET'));
});

test('caches isolés : une lecture du VPS 2 ne réutilise pas le cache du VPS 1 ; /live ciblé', async () => {
  const { app, a, b } = twoVps();
  const cookie = await login(app);
  await app.inject({ url: '/api/infrastructure?server=vps-1', headers: { cookie } });
  const before = b.fetch.calls.length;
  assert.equal(before, 0, 'le VPS 2 n’est pas sollicité par une lecture du VPS 1');
  await app.inject({ url: '/api/infrastructure/live?server=vps-2', headers: { cookie } });
  assert.ok(b.fetch.calls.length > 0);
  assert.ok(!a.fetch.calls.some((c) => /server\.one/.test(c.url)));
});
