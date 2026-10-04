// Contexte des services, capacités par version/OpenAPI, états du monitoring VPS et lecture des journaux.
// Aucun appel réseau réel : faux fetch uniquement. Les valeurs « CANARY_* » ne doivent JAMAIS apparaître en sortie.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DokployClient, detectCapabilities, safeErrorMessage } from '../src/dokploy.js';
import { buildApp } from '../src/app.js';
import { fakeFetch, makeApp, login, testConfig, totpClock, TEST_TOTP_SECRET } from './helpers.js';

const NOW = Date.parse('2026-10-01T00:00:00Z');
const GIB = 1024 ** 3;
const CANARIES = ['CANARY_ENV', 'CANARY_BUILD', 'CANARY_REFRESH', 'CANARY_PASSWORD', 'CANARY_DOMAIN', 'CANARY_LOGPATH', 'API_SECRET', 'METRICS_SECRET'];
const noCanary = (value, label = '') => { const text = typeof value === 'string' ? value : JSON.stringify(value); for (const c of CANARIES) assert.ok(!text.includes(c), `${label} contient ${c}`); };

// Lignes COMPLÈTES comme en v0.26.5 pour owner/admin : seules les clés de l'allowlist peuvent sortir.
const full = (extra) => ({ env: 'CANARY_ENV', buildArgs: 'CANARY_BUILD', refreshToken: 'CANARY_REFRESH', password: 'CANARY_PASSWORD', databasePassword: 'CANARY_PASSWORD', domains: [{ host: 'CANARY_DOMAIN' }], ...extra });
const project26 = () => [
  { projectId: 'p1', name: 'Alpha', env: 'CANARY_ENV', environments: [{ environmentId: 'e1', name: 'production', applications: [full({ applicationId: 'a1', name: 'app', appName: 'app-111', applicationStatus: 'done' })], compose: [], postgres: [full({ postgresId: 'db1', name: 'pg', appName: 'pg-1', applicationStatus: 'done' })], mysql: [], mariadb: [], mongo: [], redis: [] }] },
  { projectId: 'p2', name: 'Beta', environments: [
    { environmentId: 'e2', name: 'production', applications: [full({ applicationId: 'a2', name: 'app', appName: 'app-222', applicationStatus: 'running' })], compose: [full({ composeId: 'c2', name: 'stack', composeStatus: 'done' })] },
    { environmentId: 'e3', name: 'staging', applications: [full({ applicationId: 'a3', name: 'app', appName: 'app-333', applicationStatus: 'error' })] }] }
];

// Réponse : valeur brute (JSON) ou objet { status, json, body } déjà formé.
const resp = (v, dflt) => v === undefined ? { json: dflt } : v && !Array.isArray(v) && typeof v === 'object' && ('json' in v || 'status' in v || 'body' in v) ? v : { json: v };

function make({ version = 'v0.30.8', projects = project26(), schema, metricsConfig, metrics, logs, deployments, projectOne = true, now = () => NOW, apiKey = 'API_SECRET' } = {}) {
  const dep = deployments || {
    a1: [{ deploymentId: 'd-a1', title: 't', status: 'error', createdAt: '2026-09-30T10:00:00Z', startedAt: '2026-09-30T10:00:05Z', finishedAt: '2026-09-30T10:03:10Z', logPath: '/etc/CANARY_LOGPATH/x.log', errorMessage: 'Build failed: exit code 1' }],
    a2: [{ deploymentId: 'd-a2', status: 'done', createdAt: '2026-09-30T11:00:00Z', errorMessage: 'clone https://u:CANARY_PASSWORD@git.test/r.git failed' }],
    a3: [{ deploymentId: 'd-a3', status: 'cancelled', createdAt: '2026-09-30T12:00:00Z', errorMessage: 'See /var/lib/dokploy/logs/CANARY_LOGPATH' }], c2: []
  };
  const q = (url, key) => new URL(url).searchParams.get(key);
  const routes = [
    [/settings.getDokployVersion/, () => ({ json: version })],
    ...(schema === undefined ? [] : [[/settings.getOpenApiDocument/, () => (typeof schema === 'function' ? schema() : { json: schema })]]),
    [/project.all/, () => ({ json: projects })],
    [/project.one/, (url) => projectOne ? ({ json: projects.find((p) => p.projectId === q(url, 'projectId')) }) : ({ status: 500, json: { message: 'CANARY_ENV' } })],
    [/deployment.allByCompose/, (url) => ({ json: dep[q(url, 'composeId')] || [] })],
    [/deployment.all/, (url) => ({ json: dep[q(url, 'applicationId')] || [] })],
    [/deployment.readLogs/, () => (typeof logs === 'function' ? logs() : { json: logs ?? 'ok' })],
    [/user.getMetricsToken/, () => resp(metricsConfig, { serverIp: '127.0.0.1', enabledFeatures: true, metricsConfig: { server: { port: 4500, token: 'METRICS_SECRET', urlCallback: 'https://dash.test/cb' } } })],
    [/server.getServerMetrics/, () => resp(metrics, [{ cpu: '24.00', memUsedGB: '3.20', memTotal: '8.00', totalDisk: '80.00', diskUsed: '52.50', timestamp: '2026-09-30T23:58:00Z' }])],
    [/application.redeploy/, (_u, init) => { dep.a1.unshift({ deploymentId: 'new', title: JSON.parse(init.body).title, status: 'running', createdAt: '2026-10-01T00:00:01Z' }); return { body: '' }; }]
  ];
  const fetch = fakeFetch(routes);
  return { client: new DokployClient({ url: 'https://dokploy.example.test', apiKey }, { fetch, now }), fetch };
}

test('Plusieurs services « app » : contexte lisible, identifiants stables, aucune donnée brute', async () => {
  const snap = await make({ version: 'v0.26.5' }).client.snapshot();
  const apps = snap.services.filter((s) => s.name === 'app');
  assert.equal(apps.length, 3);
  assert.deepEqual(apps.map((s) => s.id).sort(), ['a1', 'a2', 'a3']);
  assert.deepEqual(apps.map((s) => s.context).sort(), ['Alpha → production → app', 'Beta → production → app', 'Beta → staging → app']);
  const a3 = apps.find((s) => s.id === 'a3');
  assert.deepEqual([a3.projectId, a3.projectName, a3.environmentId, a3.environmentName, a3.serviceId, a3.serviceName, a3.type], ['p2', 'Beta', 'e3', 'staging', 'a3', 'app', 'application']);
  assert.ok(snap.services.some((s) => s.type === 'postgres' && s.id === 'db1' && s.canRedeploy === false));
  assert.equal(snap.services.length, 5);
  noCanary(snap, 'snapshot'); assert.ok(!JSON.stringify(snap).includes('"env"')); assert.ok(!JSON.stringify(snap).includes('refreshToken'));
});

test('Déploiements : contexte hérité du service, durée, message d’erreur seulement s’il est sûr, logPath jamais exposé', async () => {
  const snap = await make().client.snapshot();
  const byId = Object.fromEntries(snap.deployments.map((d) => [d.id, d]));
  assert.equal(byId['d-a1'].context, 'Alpha → production → app'); assert.equal(byId['d-a1'].serviceId, 'a1'); assert.equal(byId['d-a1'].projectName, 'Alpha');
  assert.equal(byId['d-a1'].durationSeconds, 185); assert.equal(byId['d-a1'].errorMessage, 'Build failed: exit code 1'); assert.equal(byId['d-a1'].errorMessageHidden, false);
  assert.equal(byId['d-a2'].errorMessage, null); assert.equal(byId['d-a2'].errorMessageHidden, true);  // identifiants dans une URL
  assert.equal(byId['d-a3'].errorMessage, null); assert.equal(byId['d-a3'].errorMessageHidden, true);  // chemin absolu
  assert.equal(byId['d-a3'].status, 'cancelled'); assert.equal(byId['d-a2'].durationSeconds, null);
  noCanary(snap, 'deployments'); assert.ok(!JSON.stringify(snap).includes('logPath'));
  assert.deepEqual(safeErrorMessage(''), { text: null, hidden: false });
  assert.equal(safeErrorMessage('x'.repeat(400)).hidden, true);
});

test('Champs absents ⇒ null, « inconnu » à l’affichage ; HTML conservé tel quel (échappé par le frontend)', async () => {
  const projects = [{ projectId: 'p9', environments: [{ applications: [{ applicationId: 'x1' }, { applicationId: 'x2', name: '<b>svc</b> & "q" \'s\'' }], postgres: ['bare-id-1'] }] },
    { projectId: 'p8', name: '<img src=x onerror=alert(1)>', environments: [{ environmentId: 'e8', name: '"><script>', applications: [{ applicationId: 'y1', name: 'app' }] }] }, null, 'junk'];
  const snap = await make({ projects, deployments: {} }).client.snapshot();
  assert.equal(snap.status, 'connected');
  const x1 = snap.services.find((s) => s.id === 'x1');
  assert.equal(x1.projectName, null); assert.equal(x1.environmentName, null); assert.equal(x1.name, null);
  assert.equal(x1.context, 'Projet inconnu → Environnement inconnu → Service inconnu · réf. x1');
  assert.equal(snap.services.find((s) => s.id === 'bare-id-1').type, 'postgres');
  assert.equal(snap.services.find((s) => s.id === 'x2').context, 'Projet inconnu → Environnement inconnu → <b>svc</b> & "q" \'s\'');
  assert.equal(snap.services.find((s) => s.id === 'y1').context, '<img src=x onerror=alert(1)> → "><script> → app');
  assert.equal(x1.status, 'Indisponible');
});

test('Contextes identiques : repère d’affichage distinct, identifiants techniques intacts', async () => {
  const projects = [{ projectId: 'p', name: 'P', environments: [{ environmentId: 'e', name: 'E', applications: [{ applicationId: 'k1', name: 'app', appName: 'app-k1' }, { applicationId: 'k2', name: 'app', appName: 'app-k2' }] }] }];
  const snap = await make({ projects, deployments: {} }).client.snapshot();
  assert.deepEqual(snap.services.map((s) => s.context), ['P → E → app · app-k1', 'P → E → app · app-k2']);
  assert.deepEqual(snap.services.map((s) => s.id), ['k1', 'k2']);
});

test('Forme v0.30.8 (id/status, bases en identifiant seul) et project.one en échec : repli sur project.all', async () => {
  const projects = [{ projectId: 'p', name: 'Gamma', environments: [{ environmentId: 'e', name: 'prod', applications: [{ id: 'n1', name: 'app', status: 'done' }], compose: [{ id: 'n2', name: 'stk', status: 'running' }], libsql: ['ignored'], postgres: ['dbonly'] }], projectTags: [] }];
  const snap = await make({ projects, projectOne: false, deployments: { n1: [], n2: [] } }).client.snapshot();
  assert.equal(snap.status, 'connected');
  assert.deepEqual(snap.services.map((s) => `${s.type}:${s.id}:${s.status}`).sort(), ['application:n1:done', 'compose:n2:running', 'postgres:dbonly:Indisponible']);
  assert.equal(snap.services.find((s) => s.id === 'dbonly').name, null);
  assert.ok(snap.notes.some((n) => /Détails de certains projets/.test(n)));
});

test('Capacités : OpenAPI prioritaire, puis version, sinon inconnu ; schéma inaccessible ne bloque rien', async () => {
  const doc = (paths) => ({ openapi: '3.0.3', paths: Object.fromEntries(paths.map((p) => [p, {}])) });
  const withLogs = await make({ version: 'v0.26.5', schema: doc(['/deployment.all', '/deployment.readLogs', '/user.getMetricsToken', '/server.getServerMetrics']) }).client.snapshot();
  assert.equal(withLogs.capabilities.deploymentLogs, 'supported'); assert.equal(withLogs.capabilities.deploymentLogsSource, 'openapi'); assert.equal(withLogs.capabilities.schema, 'available');
  const without = await make({ version: 'v0.26.5', schema: doc(['/deployment.all']) }).client.snapshot();
  assert.equal(without.capabilities.deploymentLogs, 'supported');
  assert.equal(without.capabilities.deploymentLogsTransport, 'websocket');
  assert.match(without.capabilities.deploymentLogsReason, /WebSocket natif/);
  assert.equal(without.capabilities.monitoring, 'unsupported'); assert.equal(without.server.status, 'unsupported');
  const bad = await make({ version: 'v0.30.8', schema: () => ({ status: 403, json: {} }) }).client.snapshot();
  assert.equal(bad.status, 'connected'); assert.equal(bad.capabilities.schema, 'unavailable'); assert.equal(bad.capabilities.deploymentLogs, 'supported'); assert.equal(bad.services.length, 5);
  const empty = await make({ schema: { paths: {} } }).client.snapshot();
  assert.equal(empty.capabilities.schema, 'unavailable');
  const cases = [['v0.26.5', 'supported'], ['0.26.5', 'supported'], [' V0.26.5 ', 'supported'], ['0.26.4', 'unknown'], ['0.25.1', 'unknown'], ['0.27.0', 'unknown'], ['v0.28.0', 'unknown'],
    ['v0.30.8', 'supported'], ['0.30.8', 'supported'], ['0.30.9', 'unknown'], ['v0.31.0', 'unknown'], ['1.0.0', 'unknown'], ['0.26.5-rc.1', 'unknown'], ['canary', 'unknown'], ['', 'unknown'], [{}, 'unknown'], [null, 'unknown']];
  for (const [version, expected] of cases) assert.equal(detectCapabilities(version, null).deploymentLogs, expected, String(version));
  assert.equal(detectCapabilities('0.27.0', null).deploymentLogsSource, 'unknown');
  assert.equal(detectCapabilities('v0.30.8', new Set(['deployment.all'])).deploymentLogs, 'unsupported');   // le schéma prime sur la version
  assert.equal(detectCapabilities('v0.26.5', new Set(['deployment.readLogs'])).deploymentLogs, 'supported');
  for (const v of ['0.27.0', '0.30.9', 'canary', null]) {      // schéma accessible : la version est ignorée
    assert.equal(detectCapabilities(v, new Set(['deployment.readLogs'])).deploymentLogs, 'supported', String(v));
    assert.equal(detectCapabilities(v, new Set(['deployment.all'])).deploymentLogs, 'unsupported', String(v));
  }
});

test('Schéma OpenAPI mis en cache (un seul appel entre deux snapshots)', async () => {
  const { client, fetch } = make({ schema: { paths: { '/deployment.readLogs': {} } } });
  await client.snapshot(true); await client.snapshot(true);
  assert.equal(fetch.calls.filter((c) => /getOpenApiDocument/.test(c.url)).length, 1);
});

test('Monitoring : tous les états, jamais « non activé » sans preuve, 0 % distinct de l’absence', async () => {
  const cfg = (server, extra = {}) => ({ serverIp: '127.0.0.1', enabledFeatures: true, metricsConfig: { server }, ...extra });
  const point = (o = {}) => ({ cpu: '24.00', memUsedGB: '3.20', memTotal: '8.00', totalDisk: '80.00', diskUsed: '52.50', timestamp: '2026-09-30T23:58:00Z', ...o });
  const run = async (opts) => (await make(opts).client.snapshot()).server;
  const none = await run({ metricsConfig: { json: cfg({ port: 4500, token: '', urlCallback: '' }) } });
  assert.equal(none.status, 'not_configured'); assert.match(none.message, /non configuré dans Dokploy/); assert.equal(none.cpuPercent, null);
  assert.equal((await run({ metricsConfig: { json: cfg({ port: 4500, token: '', urlCallback: 'https://x.test' }) } })).status, 'incomplete_config');
  assert.equal((await run({ metricsConfig: { json: cfg({ port: 4500, token: 'METRICS_SECRET' }, { serverIp: '' }) } })).status, 'incomplete_config');
  assert.equal((await run({ metricsConfig: { json: cfg({ port: 0, token: 'METRICS_SECRET' }) } })).status, 'incomplete_config');
  assert.equal((await run({ metricsConfig: { json: { serverIp: '1.2.3.4' } } })).status, 'incompatible_response');
  assert.equal((await run({ metricsConfig: { status: 403, json: { message: 'x' } } })).status, 'permission');
  assert.equal((await run({ metricsConfig: { status: 404, json: { message: 'No procedure found' } } })).status, 'unsupported');
  assert.equal((await run({ metrics: { status: 403, json: {} } })).status, 'permission');
  assert.equal((await run({ metrics: { status: 500, json: { message: 'fetch failed' } } })).status, 'network');
  assert.equal((await run({ metrics: { status: 500, json: { message: 'Error 401: Unauthorized' } } })).status, 'incomplete_config');
  assert.equal((await run({ metrics: { status: 500, json: { message: 'No monitoring data available' } } })).status, 'no_data');
  assert.equal((await run({ metrics: { status: 500, json: { message: 'boom' } } })).status, 'unknown');
  assert.equal((await run({ metrics: { json: [] } })).status, 'no_data');
  assert.equal((await run({ metrics: { json: { not: 'array' } } })).status, 'incompatible_response');
  assert.equal((await run({ metrics: { json: [{ foo: 1 }] } })).status, 'incompatible_response');
  assert.equal((await run({ metrics: { json: ['x'] } })).status, 'incompatible_response');
  const stale = await run({ metrics: { json: [point({ timestamp: '2026-09-30T23:50:00Z' })] } });
  assert.equal(stale.status, 'stale'); assert.equal(stale.cpuPercent, 24);
  assert.equal((await run({ metrics: { json: [point({ timestamp: 'n/a' })] } })).status, 'unknown');
  // Valeurs en chaînes « %.2f », dernier point = le plus récent
  const ok = await run({ metrics: { json: [point({ cpu: '99.00', timestamp: '2026-09-30T23:40:00Z' }), point({ cpu: '12.50' })] } });
  assert.equal(ok.status, 'available'); assert.equal(ok.cpuPercent, 12.5); assert.equal(ok.ramUsedBytes, 3.2 * GIB); assert.equal(ok.ramTotalBytes, 8 * GIB);
  assert.equal(ok.storageTotalBytes, 80 * GIB); assert.equal(ok.storageUsedBytes, 80 * GIB * 52.5 / 100); assert.equal(ok.message, null);
  // Vrai 0 % : valeur 0, pas null
  const zero = await run({ metrics: { json: [point({ cpu: '0.00', memUsedGB: '0.00', diskUsed: '0.00' })] } });
  assert.equal(zero.status, 'available'); assert.equal(zero.cpuPercent, 0); assert.equal(zero.ramUsedBytes, 0); assert.equal(zero.storageUsedBytes, 0);
  const partial = await run({ metrics: { json: [point({ cpu: '', memUsedGB: null, diskUsed: undefined })] } });
  assert.equal(partial.cpuPercent, null); assert.equal(partial.ramUsedBytes, null); assert.equal(partial.storageUsedBytes, null); assert.equal(partial.ramTotalBytes, 8 * GIB);
  for (const s of [none, stale, ok, zero]) { noCanary(s, 'monitoring'); assert.doesNotMatch(String(s.message), /non activé/i); }
  // enabledFeatures (licence) ne prouve rien : monitoring non configuré malgré enabledFeatures: true
  assert.equal(none.status, 'not_configured');
  // La connexion API reste distincte du monitoring
  const snap = await make({ metricsConfig: { json: cfg({ port: 4500, token: '', urlCallback: '' }) } }).client.snapshot();
  assert.equal(snap.connection.status, 'connected'); assert.equal(snap.status, 'connected'); assert.equal(snap.server.status, 'not_configured');
});

test('Connexion en erreur : monitoring « unknown » non vérifié, connexion en auth/network', async () => {
  const bad = new DokployClient({ url: 'https://d.example.test', apiKey: 'API_SECRET' }, { fetch: fakeFetch([[/./, () => ({ status: 401, json: {} })]]) });
  const snap = await bad.snapshot();
  assert.equal(snap.connection.status, 'error'); assert.equal(snap.connection.reason, 'auth'); assert.equal(snap.server.status, 'unknown');
  assert.equal(snap.capabilities.deploymentLogs, 'unknown'); noCanary(snap);
  const none = await new DokployClient().snapshot();
  assert.equal(none.connection.status, 'not_configured'); assert.equal(none.server.status, 'unknown');
});

test('Logs : non supporté (aucun appel readLogs), inconnu, permission, vide, temporaire, filtré, disponible', async () => {
  const unsupported = make({ version: 'v0.26.6', schema: { paths: { '/deployment.all': {} } } });
  await unsupported.client.snapshot();
  const u = await unsupported.client.logs('d-a1');
  assert.equal(u.state, 'unsupported'); assert.equal(u.available, false); assert.match(u.message, /^Dokploy v0\.26\.6 ne fournit pas la lecture des journaux/);
  assert.ok(!unsupported.fetch.calls.some((c) => /readLogs/.test(c.url)));
  // Capacité inconnue (version intermédiaire, schéma inaccessible) : l'appel est tenté
  const unk = make({ version: 'v0.28.0', logs: 'Build ok' }); await unk.client.snapshot();
  assert.equal((await unk.client.snapshot()).capabilities.deploymentLogs, 'unknown');
  assert.equal((await unk.client.logs('d-a1')).state, 'available');
  const route = make({ version: 'v0.28.0', logs: () => ({ status: 404, json: { message: 'No procedure found on path "deployment.readLogs"' } }) }); await route.client.snapshot();
  assert.equal((await route.client.logs('d-a1')).state, 'unsupported');
  const perm = make({ logs: () => ({ status: 403, json: {} }) }); await perm.client.snapshot();
  const p = await perm.client.logs('d-a1'); assert.equal(p.state, 'permission'); assert.match(p.message, /Droits insuffisants/);
  const empty = make({ logs: '   \n' }); await empty.client.snapshot();
  assert.equal((await empty.client.logs('d-a1')).state, 'empty');
  const temp = make({ logs: () => ({ status: 502, json: {} }) }); await temp.client.snapshot();
  assert.equal((await temp.client.logs('d-a1')).state, 'temporary');
  const filtered = make({ logs: 'start\nDB_PASSWORD=CANARY_PASSWORD\nend' }); await filtered.client.snapshot();
  const f = await filtered.client.logs('d-a1'); assert.equal(f.state, 'available'); assert.equal(f.filtered, true); assert.ok(!f.logs.includes('CANARY_PASSWORD')); assert.ok(f.logs.includes('start'));
  const trunc = make({ logs: Array.from({ length: 500 }, (_, i) => `l${i}`).join('\n') }); await trunc.client.snapshot();
  const t = await trunc.client.logs('d-a1'); assert.equal(t.truncated, true); assert.equal(t.filtered, true);
  const clean = make({ logs: 'rien à signaler' }); await clean.client.snapshot();
  const c = await clean.client.logs('d-a1'); assert.equal(c.filtered, false); assert.equal(c.truncated, false);
  await assert.rejects(clean.client.logs('inconnu'), (e) => e.code === 'deployment_unknown');
  noCanary([u, p, f, t, c]);
});

test('Redéploiement : contexte du service dans la réponse et le suivi', async () => {
  const { client } = make(); await client.snapshot();
  const r = await client.redeploy('application', 'a1', true);
  assert.equal(r.serviceId, 'a1'); assert.equal(r.context, 'Alpha → production → app'); assert.equal(r.projectName, 'Alpha');
  const op = await client.operation(r.operationId);
  assert.equal(op.context, 'Alpha → production → app'); assert.equal(op.deployment.context, 'Alpha → production → app');
  await assert.rejects(client.redeploy('application', 'a1', true), (e) => e.code === 'redeploy_running');
});

test('Routes : session obligatoire, origine contrôlée, aucune fuite de secret dans les réponses', async () => {
  const { client } = make({ logs: 'ligne\nAuthorization: Bearer CANARY_PASSWORD' });
  const clock = totpClock();
  const { app } = makeApp({ dokploy: client, now: clock.now, env: { DASHBOARD_TOTP_SECRET: TEST_TOTP_SECRET } });
  for (const url of ['/api/infrastructure', '/api/deployments/d-a1/logs', '/api/infrastructure/operations/x']) assert.equal((await app.inject({ url })).statusCode, 401);
  assert.equal((await app.inject({ method: 'POST', url: '/api/infrastructure/services/application/a1/redeploy', headers: { origin: 'https://dash.example.test' }, payload: { confirmed: true } })).statusCode, 401);
  const cookie = await login(app, undefined, { totp: clock.code() });
  const infra = await app.inject({ url: '/api/infrastructure', headers: { cookie } });
  assert.equal(infra.statusCode, 200); noCanary(infra.body, 'infrastructure');
  const logs = await app.inject({ url: '/api/deployments/d-a1/logs', headers: { cookie } });
  assert.equal(logs.json().state, 'available'); noCanary(logs.body, 'logs');
  const post = (headers) => app.inject({ method: 'POST', url: '/api/infrastructure/services/application/a1/redeploy', headers: { cookie, ...headers }, payload: { confirmed: true, totp: clock.code() } });
  assert.equal((await post({ origin: 'https://attacker.test' })).statusCode, 403);
  const ok = await post({ origin: 'https://dash.example.test' });
  assert.equal(ok.statusCode, 202); noCanary(ok.body, 'redeploy');
  const op = await app.inject({ url: `/api/infrastructure/operations/${ok.json().operationId}`, headers: { cookie } });
  assert.equal(op.json().context, 'Alpha → production → app'); noCanary(op.body, 'operation');
});
