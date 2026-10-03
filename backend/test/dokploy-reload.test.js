import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DokployClient } from '../src/dokploy.js';
import { fakeFetch, makeApp, login } from './helpers.js';

const NOW = Date.parse('2026-10-01T00:00:00Z');
const CANARY = 'CANARY_SECRET_VALUE';

// Faux Dokploy hors réseau : `reload` décide de la réponse, `statuses` de la suite des statuts relus.
function fixture({ reload = () => ({ json: true }), statuses = ['done'], appName = 'api-abc123', paths, gate } = {}) {
  let statusIndex = 0, reloaded = false;
  const app = () => ({ applicationId: 'a', name: 'API <b>x</b>', appName, applicationStatus: reloaded ? statuses[Math.min(statusIndex++, statuses.length - 1)] : 'done', env: CANARY });
  const project = () => ({ projectId: 'p', name: 'Projet <img src=x onerror=alert(1)>', env: CANARY, environments: [{ environmentId: 'e', name: 'prod', applications: [app()], compose: [{ composeId: 'c', name: 'Stack', composeStatus: 'done' }], postgres: [{ postgresId: 'db', name: 'DB', applicationStatus: 'done' }] }] });
  const fetch = fakeFetch([
    [/settings.getDokployVersion/, () => ({ json: 'v0.30.8' })],
    [/settings.getOpenApiDocument/, () => paths ? ({ json: { paths: Object.fromEntries(paths.map((p) => [`/${p}`, {}])) } }) : ({ status: 404, json: {} })],
    [/project.all/, () => ({ json: [project()] })],
    [/project.one/, () => ({ json: project() })],
    [/deployment.all/, () => ({ json: [] })],
    [/application.redeploy/, () => ({ body: '' })],
    [/application.reload/, async (_u, init) => { if (gate) await gate; const r = reload(JSON.parse(init.body)); if (!r.status || r.status < 300) reloaded = true; return r; }],
    [/user.getMetricsToken/, () => ({ json: { serverIp: '127.0.0.1', metricsConfig: { server: { port: 4500, token: '' } } } })],
  ]);
  const client = new DokployClient({ url: 'https://dokploy.example.test', apiKey: 'API_SECRET' }, { fetch, now: () => NOW, sleep: async () => {} });
  return { client, fetch };
}
const reloadCalls = (fetch) => fetch.calls.filter((c) => /application\.reload/.test(c.url));
const settle = async (client, id) => { for (let i = 0; i < 50; i++) { const op = await client.operation(id); if (!['pending', 'running'].includes(op.status)) return op; await new Promise((r) => setTimeout(r, 2)); } throw new Error('opération non terminée'); };

test('reload nominal : réponse true, un seul POST {applicationId, appName}, statut done relu', async () => {
  const { client, fetch } = fixture();
  const res = await client.reload('a', true);
  assert.equal(res.status, 'running'); assert.equal(res.serviceType, 'application');
  const op = await settle(client, res.operationId);
  assert.equal(op.status, 'done'); assert.match(op.message, /^Rechargement terminé/); assert.match(op.message, /ne garantit pas/);
  const calls = reloadCalls(fetch); assert.equal(calls.length, 1);
  assert.equal(calls[0].init.method, 'POST'); assert.equal(calls[0].init.headers['Content-Type'], 'application/json'); assert.equal(calls[0].init.headers['x-api-key'], 'API_SECRET');
  assert.deepEqual(JSON.parse(calls[0].init.body), { applicationId: 'a', appName: 'api-abc123' });
  assert.ok(!JSON.stringify([res, op]).includes(CANARY)); assert.ok(!JSON.stringify([res, op]).includes('API_SECRET'));
});

test('reload : corps vide toléré', async () => {
  const { client } = fixture({ reload: () => ({ body: '' }) }); const res = await client.reload('a', true);
  assert.equal((await settle(client, res.operationId)).status, 'done');
});

test('reload : 500 → Échec du rechargement ; 401/403 → permission ; réseau → indisponible ; sans fuite', async () => {
  const cases = [[500, /^Échec du rechargement\.$/], [401, /droits insuffisants/], [403, /droits insuffisants/]];
  for (const [status, re] of cases) {
    const { client } = fixture({ reload: () => ({ status, json: { message: CANARY } }) });
    const op = await settle(client, (await client.reload('a', true)).operationId);
    assert.equal(op.status, 'error'); assert.match(op.message, re); assert.ok(!JSON.stringify(op).includes(CANARY)); assert.ok(!JSON.stringify(op).includes('API_SECRET'));
  }
  const { client, fetch } = fixture(); const ok = fetch;
  const failing = new DokployClient({ url: 'https://dokploy.example.test', apiKey: 'API_SECRET' }, { fetch: async (u, i) => { if (/application\.reload/.test(String(u))) throw new Error(`ECONNREFUSED ${CANARY}`); return ok(u, i); }, now: () => NOW, sleep: async () => {} });
  const op = await settle(failing, (await failing.reload('a', true)).operationId);
  assert.equal(op.status, 'error'); assert.match(op.message, /indisponible/); assert.ok(!JSON.stringify(op).includes(CANARY));
});

test('reload : réponse false → erreur ; statut relu en erreur → error ; jamais « sain »', async () => {
  let f = fixture({ reload: () => ({ json: false }) });
  assert.equal((await settle(f.client, (await f.client.reload('a', true)).operationId)).status, 'error');
  f = fixture({ statuses: ['error'] });
  const op = await settle(f.client, (await f.client.reload('a', true)).operationId);
  assert.equal(op.status, 'error'); assert.match(op.message, /Échec du rechargement/);
  f = fixture({ statuses: ['done'] });
  assert.doesNotMatch((await settle(f.client, (await f.client.reload('a', true)).operationId)).message, /sain(?!té)/);
});

test('reload : statut jamais confirmé ou relecture impossible → unknown honnête', async () => {
  let f = fixture({ statuses: ['idle'] });
  let op = await settle(f.client, (await f.client.reload('a', true)).operationId);
  assert.equal(op.status, 'unknown'); assert.match(op.message, /n’a pas pu être confirmé/);
  f = fixture();
  const base = f.client.fetch; let after = false;
  f.client.fetch = async (u, i) => { const r = await base(u, i); if (/application\.reload/.test(String(u))) after = true; if (after && /project\./.test(String(u))) throw new Error('coupure'); return r; };
  op = await settle(f.client, (await f.client.reload('a', true)).operationId);
  assert.equal(op.status, 'unknown');
});

test('reload : statut transitoire (idle puis done) toléré', async () => {
  const { client } = fixture({ statuses: ['idle', 'running', 'done'] });
  assert.equal((await settle(client, (await client.reload('a', true)).operationId)).status, 'done');
});

test('reload : appName invalide ou absent → refus sans appel', async () => {
  for (const appName of ['bad name!', '../x', 'a'.repeat(64), null]) {
    const { client, fetch } = fixture({ appName });
    const snap = await client.snapshot(); assert.equal(snap.services.find((s) => s.id === 'a').canReload, false, String(appName));
    await assert.rejects(client.reload('a', true), (e) => e.status === 409 && e.code === 'reload_unavailable');
    assert.equal(reloadCalls(fetch).length, 0);
  }
});

test('reload : Compose, base, id inconnu, injection, sans confirmation → refus sans appel', async () => {
  const { client, fetch } = fixture(); await client.snapshot();
  await assert.rejects(client.reload('c', true), (e) => e.status === 409 && e.code === 'reload_unsupported_type' && /Compose/.test(e.message));
  await assert.rejects(client.reload('db', true), (e) => e.status === 409);
  await assert.rejects(client.reload('inconnu', true), (e) => e.status === 404);
  await assert.rejects(client.reload('../a', true), (e) => e.status === 400);
  await assert.rejects(client.reload('a', 'true'), (e) => e.status === 400 && e.code === 'confirmation_required');
  await assert.rejects(client.reload('a', undefined), (e) => e.status === 400);
  assert.equal(reloadCalls(fetch).length, 0);
  const snap = await client.snapshot();
  assert.deepEqual(snap.services.map((s) => [s.type, s.canReload]).sort(), [['application', true], ['compose', false], ['postgres', false]]);
});

test('Capacités : schéma sans application.reload → désactivé avec explication ; avec → autorisé ; inconnu → autorisé', async () => {
  let f = fixture({ paths: ['project.all', 'application.redeploy'] });
  let snap = await f.client.snapshot();
  assert.equal(snap.capabilities.reload, 'unsupported'); assert.ok(snap.capabilities.reloadReason); assert.equal(snap.services.find((s) => s.id === 'a').canReload, false);
  await assert.rejects(f.client.reload('a', true), (e) => e.code === 'reload_unavailable'); assert.equal(reloadCalls(f.fetch).length, 0);
  f = fixture({ paths: ['application.reload'] }); snap = await f.client.snapshot();
  assert.equal(snap.capabilities.reload, 'supported'); assert.equal(snap.services.find((s) => s.id === 'a').canReload, true);
  f = fixture(); snap = await f.client.snapshot(); assert.equal(snap.capabilities.reload, 'unknown'); assert.equal(snap.services.find((s) => s.id === 'a').canReload, true);
});

test('Anti-doublon partagé : reload/reload, reload puis redeploy, redeploy puis reload', async () => {
  let release; const gate = new Promise((r) => { release = r; });
  const { client, fetch } = fixture({ gate }); await client.snapshot();
  const results = await Promise.allSettled([client.reload('a', true), client.reload('a', true)]);
  assert.deepEqual(results.map((r) => r.status).sort(), ['fulfilled', 'rejected']);
  await assert.rejects(client.redeploy('application', 'a', true), (e) => e.status === 409);
  release(); await settle(client, results.find((r) => r.status === 'fulfilled').value.operationId);
  assert.equal(reloadCalls(fetch).length, 1);
  const red = await client.redeploy('application', 'a', true);
  await assert.rejects(client.reload('a', true), (e) => e.status === 409 && e.code === 'action_running');
  assert.equal(reloadCalls(fetch).length, 1); assert.ok(red.operationId);
});

test('Opération reload inconnue → 404 ; opérations terminées purgées', async () => {
  const { client } = fixture(); await assert.rejects(client.operation('zzz'), (e) => e.status === 404);
  const res = await client.reload('a', true); await settle(client, res.operationId);
  client.now = () => NOW + 3_700_000; client.purgeOperations(); assert.equal(client.operations.has(res.operationId), false);
});

test('Routes : session, origine, confirmation, Compose, 202 + suivi, aucun secret, nom HTML non interprété côté serveur', async () => {
  const { fetch } = fixture();
  const client = new DokployClient({ url: 'https://dokploy.example.test', apiKey: 'API_SECRET' }, { fetch, now: () => NOW, sleep: async () => {} });
  const { app } = makeApp({ dokploy: client });
  const url = '/api/infrastructure/services/application/a/reload';
  assert.equal((await app.inject({ method: 'POST', url, payload: { confirmed: true } })).statusCode, 401);
  const cookie = await login(app);
  const post = (u, payload, headers = {}) => app.inject({ method: 'POST', url: u, headers: { cookie, ...headers }, payload });
  assert.equal((await post(url, { confirmed: true }, { origin: 'https://attacker.test' })).statusCode, 403);
  assert.equal((await post(url, {})).statusCode, 400);
  assert.equal((await post(url, { confirmed: 'oui' })).statusCode, 400);
  assert.equal((await app.inject({ method: 'POST', url, headers: { cookie, 'content-type': 'text/plain' }, payload: 'confirmed' })).statusCode, 400);
  assert.equal(reloadCalls(fetch).length, 0);
  assert.equal((await post('/api/infrastructure/services/application/c/reload', { confirmed: true })).statusCode, 409);
  assert.equal((await post('/api/infrastructure/services/application/..%2Fa/reload', { confirmed: true })).statusCode, 400);
  assert.equal((await post('/api/infrastructure/services/application/zz/reload', { confirmed: true })).statusCode, 404);
  assert.equal(reloadCalls(fetch).length, 0);
  const res = await post(url, { confirmed: true });
  assert.equal(res.statusCode, 202);
  const body = res.json(); assert.ok(body.operationId); assert.match(body.context, /<img/);   // texte brut : l'échappement se fait côté navigateur
  const op = await app.inject({ url: `/api/infrastructure/operations/${body.operationId}`, headers: { cookie } });
  assert.equal(op.statusCode, 200);
  await settle(client, body.operationId);
  const final = await app.inject({ url: `/api/infrastructure/operations/${body.operationId}`, headers: { cookie } });
  assert.equal(final.json().status, 'done');
  const snap = await app.inject({ url: '/api/infrastructure', headers: { cookie } });
  for (const text of [res.body, op.body, final.body, snap.body]) { assert.ok(!text.includes(CANARY)); assert.ok(!text.includes('API_SECRET')); }
});
