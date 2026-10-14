// Mesures du VPS : une lecture ratée ne fait pas flotter l'affichage (dernière bonne mesure conservée < 5 min) et le diagnostic de l'agent reste visible.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DokployClient } from '../src/dokploy.js';
import { fakeFetch } from './helpers.js';

const T0 = Date.parse('2026-10-14T12:00:00Z');
function make() {
  const clock = { t: T0 }, state = { agent: 'ok' };
  const sample = () => [{ cpu: '20.00', memUsedGB: '2.00', memTotal: '8.00', totalDisk: '80.00', diskUsed: '50.00', timestamp: new Date(clock.t - 30_000).toISOString() }];
  const fetch = fakeFetch([
    [/settings.getDokployVersion/, () => ({ json: 'v0.30.8' })],
    [/project.all/, () => ({ json: [] })],
    [/user.getMetricsToken/, () => ({ json: { serverIp: '127.0.0.1', metricsConfig: { server: { port: 4500, token: 'METRICS_SECRET' } } } })],
    [/server.getServerMetrics/, () => (state.agent === 'ok' ? { json: sample() } : { status: 500, json: { message: 'fetch failed' } })],
    [/application.readAppMonitoring/, () => ({ json: {} })]
  ]);
  return { client: new DokployClient({ url: 'https://dokploy.example.test', apiKey: 'API_SECRET' }, { fetch, now: () => clock.t }), clock, state };
}

test('lecture ratée : la dernière bonne mesure (< 5 min) est conservée avec son horodatage réel', async () => {
  const { client, clock, state } = make();
  const good = (await client.snapshot(true)).server;
  assert.equal(good.status, 'available');
  state.agent = 'down'; clock.t += 120_000;
  const kept = (await client.snapshot(true)).server;
  assert.equal(kept.status, 'available');
  assert.equal(kept.observedAt, good.observedAt, 'jamais rajeunie');
  assert.equal(kept.cpuPercent, 20);
});

test('au-delà de 5 minutes la mesure n’est plus affichée comme actuelle, et la cause côté agent est indiquée', async () => {
  const { client, clock, state } = make();
  await client.snapshot(true);
  state.agent = 'down'; clock.t += 400_000;
  const s = (await client.snapshot(true)).server;
  assert.notEqual(s.status, 'available');
  assert.equal(s.cpuPercent, null);
  assert.match(s.message, /Agent de monitoring/);
  assert.ok(!JSON.stringify(s).includes('METRICS_SECRET'));
});
