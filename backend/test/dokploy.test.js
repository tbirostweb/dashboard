import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DokployClient, checkDokployUrl, redactLogs } from '../src/dokploy.js';
import { fakeFetch, makeApp, login } from './helpers.js';

const NOW = Date.parse('2026-10-01T00:00:00Z');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function fixture({ metrics, token = 'METRICS_SECRET', apps = 1, now = () => NOW, logs, onDeployments } = {}) {
  const deployments = { a: [{ deploymentId: 'old', title: 'old', status: 'done', createdAt: '2026-09-30T00:00:00Z' }], c: [] };
  const applications = Array.from({ length: apps }, (_, i) => ({ applicationId: i === 0 ? 'a' : `a${i}`, name: i === 0 ? 'API' : `App ${i}`, applicationStatus: 'done', env: 'TOP_SECRET' }));
  const project = { projectId: 'p', name: 'Projet réel', env: 'PRIVATE_ENV', environments: [{ applications, compose: [{ composeId: 'c', name: 'Compose', composeStatus: 'done' }], postgres: [{ postgresId: 'db', name: 'Postgres', applicationStatus: 'done' }] }] };
  const idOf = (url, key) => new URL(url).searchParams.get(key);
  const fetch = fakeFetch([
    [/settings.getDokployVersion/, () => ({ json: 'v0.30.8' })],
    [/project.all/, () => ({ json: [project] })],
    [/project.one/, () => ({ json: project })],
    [/deployment.allByCompose/, (url) => { onDeployments?.(); return { json: deployments[idOf(url, 'composeId')] || [] }; }],
    [/deployment.all/, (url) => { onDeployments?.(); return { json: deployments[idOf(url, 'applicationId')] || [] }; }],
    [/deployment.readLogs/, () => ({ json: logs ?? 'Deployment completed' })],
    // application.redeploy renvoie HTTP 200 avec un corps VIDE ; compose.redeploy renvoie {success,message}
    [/application.redeploy/, (_u, init) => { deployments.a.unshift({ deploymentId: 'new', title: JSON.parse(init.body).title, status: 'running', createdAt: '2026-10-01T00:00:01Z' }); return { body: '' }; }],
    [/compose.redeploy/, (_u, init) => { deployments.c.unshift({ deploymentId: 'cnew', title: JSON.parse(init.body).title, status: 'done', createdAt: '2026-10-01T00:00:01Z' }); return { json: { success: true, message: 'Compose deployed' } }; }],
    [/user.getMetricsToken/, () => ({ json: { serverIp: '127.0.0.1', metricsConfig: { server: { port: 4500, token } } } })],
    [/server.getServerMetrics/, () => ({ json: metrics ?? [{ cpu: 24, memUsedGB: 3.2, memTotal: 8, totalDisk: 80, diskUsed: 52.5, timestamp: '2026-09-30T23:58:00Z' }] })]
  ]);
  const client = new DokployClient({ url: 'https://dokploy.example.test', apiKey: 'API_SECRET' }, { fetch, now });
  return { client, fetch, deployments };
}

const GIB = 1024 ** 3;

test('Snapshot : version, services whitelistés, métriques en GiB, OpenAPI facultatif, aucun secret', async () => {
  const { client, fetch } = fixture(); const snapshot = await client.snapshot();
  assert.equal(snapshot.status, 'connected'); assert.equal(snapshot.version, 'v0.30.8');
  assert.deepEqual(snapshot.services.map((s) => s.type), ['application', 'compose', 'postgres']);
  assert.equal(snapshot.server.scope, 'vps'); assert.equal(snapshot.server.status, 'available'); assert.equal(snapshot.connection.status, 'connected');
  assert.equal(snapshot.server.cpuPercent, 24); assert.equal(snapshot.server.ramUsedBytes, 3.2 * GIB);
  assert.equal(snapshot.server.ramTotalBytes, 8 * GIB); assert.equal(snapshot.server.storageUsedBytes, 80 * GIB * 52.5 / 100);
  assert.equal(snapshot.server.observedAt, '2026-09-30T23:58:00Z');
  assert.ok(!JSON.stringify(snapshot).includes('SECRET')); assert.ok(!JSON.stringify(snapshot).includes('PRIVATE_ENV'));
  assert.equal(snapshot.capabilities.schema, 'unavailable'); // schéma non mocké : lecture non bloquée
  assert.ok(fetch.calls.every((c) => c.init.headers['x-api-key'] === 'API_SECRET'));
});

test('redeploy application : corps vide toléré ; compose {success,message} aussi ; suivi ciblé sans snapshot', async () => {
  const { client, fetch } = fixture(); await client.snapshot();
  const result = await client.redeploy('application', 'a', true);
  const mutation = fetch.calls.find((c) => /application.redeploy/.test(c.url));
  assert.equal(mutation.init.method, 'POST'); assert.ok(!mutation.init.body.includes('freshVolumes'));
  assert.equal((await client.operation(result.operationId)).status, 'running');
  const before = fetch.calls.length;
  const op = await client.operation(result.operationId);
  assert.equal(op.deployment.id, 'new');
  assert.ok(fetch.calls.slice(before).every((c) => /deployment\.all\?applicationId=a/.test(c.url)), 'lecture ciblée uniquement');
  const compose = await client.redeploy('compose', 'c', true);
  const done = await client.operation(compose.operationId);
  assert.equal(done.status, 'done'); assert.equal(done.message, 'Déploiement réussi.');
});

test('Corps vide et chaîne JSON brute tolérés par request ; seul un statut non-2xx échoue', async () => {
  const client = new DokployClient({ url: 'https://d.example.test', apiKey: 'K' }, { fetch: fakeFetch([[/empty/, () => ({ body: '' })], [/raw/, () => ({ body: '"v0.30.8"' })], [/boom/, () => ({ status: 500, body: 'x' })]]) });
  assert.equal(await client.request('empty'), null);
  assert.equal(await client.request('raw'), 'v0.30.8');
  await assert.rejects(client.request('boom'), (err) => err.reason === 'http');
});

test('Déploiement cancelled : état terminal « annulé », jamais running', async () => {
  const { client, deployments } = fixture(); await client.snapshot();
  const result = await client.redeploy('application', 'a', true);
  deployments.a[0].status = 'cancelled';
  const op = await client.operation(result.operationId);
  assert.equal(op.status, 'cancelled'); assert.equal(op.message, 'Déploiement annulé.');
  assert.equal((await client.operation(result.operationId)).status, 'cancelled');
  assert.equal((await client.snapshot(true)).deployments[0].status, 'cancelled');
});

test('401/403 (clé ou droits) distingués d’une panne réseau, en HTTP 200 sans secret', async () => {
  for (const status of [401, 403]) {
    const client = new DokployClient({ url: 'https://d.example.test', apiKey: 'PRIVATE_KEY' }, { fetch: fakeFetch([[/./, () => ({ status, json: { message: 'PRIVATE_KEY', env: 'PRIVATE_ENV' } })]]) });
    const r = await client.snapshot(); assert.equal(r.status, 'error'); assert.equal(r.reason, 'auth');
    assert.match(r.notes[0], /invalide ou droits insuffisants/); assert.ok(!JSON.stringify(r).includes('PRIVATE_'));
  }
  const down = new DokployClient({ url: 'https://d.example.test', apiKey: 'PRIVATE_KEY' }, { fetch: async () => { throw new Error('ECONNREFUSED PRIVATE_KEY'); } });
  const r = await down.snapshot(); assert.equal(r.reason, 'network'); assert.match(r.notes[0], /injoignable/); assert.ok(!JSON.stringify(r).includes('PRIVATE_'));
  assert.equal((await new DokployClient().snapshot()).status, 'not_configured');
});

test('Schéma OpenAPI inaccessible : la lecture réussit et la version décide', async () => {
  const { client } = fixture();
  const snapshot = await client.snapshot();
  assert.equal(snapshot.status, 'connected'); assert.ok(snapshot.capabilities.redeploy);
  assert.equal(snapshot.capabilities.deploymentLogs, 'supported'); assert.equal(snapshot.capabilities.deploymentLogsSource, 'version');
});

test('Deux redeploy simultanés : un seul est accepté', async () => {
  const { client, fetch } = fixture(); await client.snapshot();
  const results = await Promise.allSettled([client.redeploy('application', 'a', true), client.redeploy('application', 'a', true)]);
  assert.deepEqual(results.map((r) => r.status).sort(), ['fulfilled', 'rejected']);
  assert.equal(results.find((r) => r.status === 'rejected').reason.code, 'redeploy_running');
  assert.equal(fetch.calls.filter((c) => /application.redeploy/.test(c.url)).length, 1);
});

test('Type invalide, injection et absence de confirmation refusés sans appel Dokploy', async () => {
  const { client, fetch } = fixture(); await client.snapshot(); const calls = fetch.calls.length;
  await assert.rejects(client.redeploy('application', 'a', false), (e) => e.code === 'confirmation_required');
  await assert.rejects(client.redeploy('postgres', 'db', true), (e) => e.code === 'service_type_invalid');
  await assert.rejects(client.redeploy('../application', 'a', true), (e) => e.code === 'service_type_invalid');
  await assert.rejects(client.redeploy('application', '../a', true), (e) => e.code === 'service_id_invalid');
  await assert.rejects(client.logs('../../etc/passwd'), (e) => e.code === 'deployment_invalid');
  await assert.rejects(client.redeploy('application', 'inconnu', true), (e) => e.code === 'redeploy_unavailable');
  assert.equal(fetch.calls.length, calls);
});

test('Routes infrastructure : session obligatoire, origine, confirmation et type validés', async () => {
  const { app } = makeApp();
  for (const url of ['/api/infrastructure', '/api/deployments/old/logs', '/api/infrastructure/operations/op']) assert.equal((await app.inject({ url })).statusCode, 401);
  assert.equal((await app.inject({ method: 'POST', url: '/api/infrastructure/services/application/a/redeploy', headers: { origin: 'https://dash.example.test' }, payload: { confirmed: true } })).statusCode, 401);
  const cookie = await login(app);
  assert.equal((await app.inject({ url: '/api/infrastructure', headers: { cookie } })).json().status, 'not_configured');
  const post = (url, payload, headers = {}) => app.inject({ method: 'POST', url, headers: { cookie, origin: 'https://dash.example.test', ...headers }, payload });
  assert.equal((await post('/api/infrastructure/services/application/a/redeploy', { confirmed: true }, { origin: 'https://attacker.test' })).statusCode, 403);
  assert.equal((await post('/api/infrastructure/services/application/a/redeploy', {})).statusCode, 400);
  assert.equal((await post('/api/infrastructure/services/postgres/db/redeploy', { confirmed: true })).statusCode, 400);
  assert.equal((await post('/api/infrastructure/services/application/..%2Fa/redeploy', { confirmed: true })).statusCode, 400);
});

test('Rate limit : 30 requêtes par minute et par session sur /api/infrastructure*', async () => {
  const { app } = makeApp(); const cookie = await login(app);
  let last;
  for (let i = 0; i < 31; i++) last = await app.inject({ url: '/api/infrastructure', headers: { cookie } });
  assert.equal(last.statusCode, 429); assert.ok(last.headers['retry-after']);
});

test('Logs expurgés par motifs : secrets factices masqués, texte utile conservé', async () => {
  const raw = [
    '\u001b[32mStep 1/4 : build\u001b[0m',
    'Authorization: Bearer FAKE_BEARER_TOKEN_123456',
    'x-api-key: FAKE_API_KEY_VALUE',
    'git clone https://user:FAKEPASS@github.test/org/repo.git',
    'DB_PASSWORD=FAKE_DB_PASS',
    '{"apiToken": "FAKE_JSON_TOKEN"}',
    'ghp_FAKEFAKEFAKEFAKEFAKEFAKEFAKE1234',
    'AKIAFAKEFAKEFAKE1234',
    'sk-FAKEFAKEFAKEFAKEFAKE1234',
    'digest ' + 'a1b2c3d4'.repeat(8),
    'token base64 ' + 'Zm9vYmFyMTIz'.repeat(4),
    '-----BEGIN PRIVATE KEY-----', 'FAKEPEMBODYLINE1', '-----END PRIVATE KEY-----',
    'Build completed in 12s'
  ].join('\n');
  const { client, fetch } = fixture({ logs: raw }); await client.snapshot();
  const result = await client.logs('old');
  assert.equal(result.available, true); assert.equal(result.redacted, true);
  for (const secret of ['FAKE_BEARER', 'FAKE_API_KEY', 'FAKEPASS', 'FAKE_DB_PASS', 'FAKE_JSON_TOKEN', 'ghp_FAKE', 'AKIAFAKE', 'sk-FAKE', 'a1b2c3d4a1b2', 'Zm9vYmFy', 'FAKEPEMBODY', '\u001b']) assert.ok(!result.logs.includes(secret), secret);
  assert.ok(result.logs.includes('Step 1/4 : build')); assert.ok(result.logs.includes('Build completed in 12s'));
  assert.equal(fetch.calls.find((c) => /readLogs/.test(c.url)).url.includes('tail=200'), true);
  await assert.rejects(client.logs('inconnu'), (e) => e.code === 'deployment_unknown');
});

test('redactLogs : seul le jeton est masqué, la guillemet fermante est conservée', () => {
  const out = redactLogs([
    'curl -H "Authorization: Bearer FAKE_TOKEN_ABC123456" https://api.test',
    "X='Authorization: Bearer FAKE_TOKEN_ABC123456' suite",
    '{"Authorization": "Bearer FAKE_TOKEN_ABC123456"}'
  ].join('\n')).text.split('\n');
  assert.equal(out[0], 'curl -H "Authorization: [masqué]" https://api.test');
  assert.equal(out[1], "X='Authorization: [masqué]' suite");
  assert.equal(out[2], '{"Authorization": "[masqué]"}');
  assert.ok(!out.join('').includes('FAKE_TOKEN'));
});

test('redactLogs : troncature à 200 lignes', () => {
  const out = redactLogs(Array.from({ length: 500 }, (_, i) => `ligne ${i}`).join('\n'));
  assert.equal(out.truncated, true); assert.equal(out.text.split('\n').length, 200); assert.ok(out.text.endsWith('ligne 499'));
});

test('Métriques : ancienne, absente et monitoring non configuré sont signalées', async () => {
  const stale = await fixture({ metrics: [{ cpu: 1, memUsedGB: 1, memTotal: 2, totalDisk: 10, diskUsed: 10, timestamp: '2026-09-30T23:50:00Z' }] }).client.snapshot();
  assert.equal(stale.server.status, 'stale'); assert.match(stale.server.message, /ancienne/); assert.equal(stale.server.observedAt, '2026-09-30T23:50:00Z');
  const empty = await fixture({ metrics: [] }).client.snapshot();
  assert.equal(empty.server.status, 'no_data'); assert.doesNotMatch(empty.server.message, /non activé/);
  const disabled = await fixture({ token: '' }).client.snapshot();
  assert.equal(disabled.server.status, 'not_configured'); assert.match(disabled.server.message, /non configuré dans Dokploy/);
  assert.ok(!JSON.stringify(disabled).includes('METRICS_SECRET'));
});

test('DOKPLOY_URL : http hors réseau privé, identifiants et /api refusés', async () => {
  assert.ok(checkDokployUrl('https://dokploy.example.test').url);
  assert.ok(checkDokployUrl('https://dokploy.exemple.fr').url);
  assert.ok(checkDokployUrl('http://host.docker.internal:3000').url);
  assert.ok(checkDokployUrl('http://localhost:3000').url); assert.ok(checkDokployUrl('http://10.0.0.5:3000').url); assert.ok(checkDokployUrl('http://dokploy:3000').url);
  for (const bad of ['http://203.0.113.10:3000', 'http://host.docker.internal:3000/api', 'http://user:pw@host.docker.internal:3000', 'http://dokploy.example.test', 'https://user:pw@dokploy.example.test', 'https://dokploy.example.test/api', 'https://dokploy.example.test?x=1', 'ftp://x.test']) assert.ok(checkDokployUrl(bad).error, bad);
  const fetch = fakeFetch([]);
  const client = new DokployClient({ url: 'http://dokploy.example.test', apiKey: 'K' }, { fetch });
  const r = await client.snapshot(); assert.equal(r.status, 'error'); assert.equal(r.reason, 'configuration'); assert.equal(fetch.calls.length, 0);
});

test('Single-flight et cache court (aussi en erreur)', async () => {
  const { client, fetch } = fixture();
  const [a, b] = await Promise.all([client.snapshot(), client.snapshot()]);
  assert.equal(a, b); assert.equal(fetch.calls.filter((c) => /project\.all/.test(c.url)).length, 1);
  await client.snapshot(); assert.equal(fetch.calls.filter((c) => /project\.all/.test(c.url)).length, 1);
  let t = NOW, hits = 0;
  const failing = new DokployClient({ url: 'https://d.example.test', apiKey: 'K' }, { now: () => t, fetch: async () => { hits++; await sleep(5); return new Response('', { status: 503 }); } });
  await Promise.all([failing.snapshot(), failing.snapshot(), failing.snapshot()]); const first = hits;
  await failing.snapshot(); assert.equal(hits, first);
  t += 6000; await failing.snapshot(); assert.ok(hits > first);
});

test('Lectures bornées à 5 en parallèle et budget global respecté', async () => {
  let current = 0, max = 0;
  const probe = fixture({ apps: 12, onDeployments: () => {} });
  const wrapped = probe.client.fetch;
  probe.client.fetch = async (...args) => { if (!/deployment\./.test(String(args[0]))) return wrapped(...args); current++; max = Math.max(max, current); await sleep(5); try { return await wrapped(...args); } finally { current--; } };
  const snap = await probe.client.snapshot();
  assert.equal(snap.services.filter((s) => s.type === 'application').length, 12); assert.ok(max <= 5, `concurrence ${max}`);
  let t = NOW;
  const slow = fixture({ apps: 12, now: () => t, onDeployments: () => { t += 9000; } });
  const partial = await slow.client.snapshot();
  assert.equal(partial.status, 'connected'); assert.ok(partial.notes.some((n) => /partiel/i.test(n)));
});

test('Opérations plafonnées : purge des terminées, jamais une opération en cours', async () => {
  const { client } = fixture();
  for (let i = 0; i < 100; i++) client.operations.set(`f${i}`, { status: 'done', startedAt: NOW, updatedAt: NOW, serviceId: `s${i}` });
  client.operations.set('active', { status: 'running', startedAt: NOW, updatedAt: NOW, serviceId: 'x' });
  client.purgeOperations();
  assert.ok(client.operations.size < 100); assert.ok(client.operations.has('active'));
  for (let i = 0; i < 6000; i++) client.remember(`d${i}`, { serviceId: 's' });
  assert.ok(client.knownDeployments.size <= 5000);
});

test('Suivi ne confond pas déploiement étranger et expire sans inventer un succès', async () => {
  let t = NOW;
  const { client, deployments } = fixture({ now: () => t }); await client.snapshot();
  const result = await client.redeploy('application', 'a', true);
  deployments.a.splice(0, 1, { deploymentId: 'foreign', title: 'autre', status: 'done', createdAt: '2026-10-01T00:00:01Z' });
  assert.equal((await client.operation(result.operationId)).status, 'pending');
  t = Date.parse('2026-10-01T00:11:00Z');
  assert.equal((await client.operation(result.operationId)).status, 'unknown');
});
