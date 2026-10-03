import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { NativeDokploy, nativeMetrics } from '../src/dokploy-native.js';
import { DokployClient, detectCapabilities } from '../src/dokploy.js';
import { fakeFetch } from './helpers.js';
const NOW = Date.parse('2026-10-01T00:00:00Z');
const t = (value, time = new Date(NOW).toISOString()) => ({ time, value });
const data = () => ({ cpu: [t('0.00%')], memory: [t({ used: '5.01GiB', total: '7.58GiB' })], disk: [t({ diskUsage: 15.49, diskTotal: 73.62 })], env: 'HIDDEN', network: [{ token: 'HIDDEN' }] });
class Socket extends EventEmitter { terminate() { if (!this.closed) { this.closed = true; this.emit('close'); } } }
const socketFactory = () => { const calls = []; return { calls, createSocket: (url, opts) => { const socket = new Socket(); calls.push({ url, opts, socket }); return socket; } }; };

test('Native host DTO : vrai zéro CPU, RAM GiB, disque GB racine, aucun champ brut', () => {
  const d = nativeMetrics(data(), NOW);
  assert.equal(d.status, 'available'); assert.equal(d.cpuPercent, 0); assert.equal(d.ramUsedBytes, 5.01 * 1024 ** 3); assert.equal(d.storageUsedBytes, 15.49 * 1000 ** 3);
  assert.equal(d.scope, 'vps'); assert.equal(d.storageScope, 'root_filesystem'); assert.equal(d.source, 'dokploy_native'); assert.ok(!JSON.stringify(d).includes('HIDDEN'));
});
test('Native mesures indépendantes périmées/futures/absentes/invalides restent null, jamais zéro inventé', () => {
  const old = new Date(NOW - 300001).toISOString();
  const stale = nativeMetrics({ cpu: [t('2%', old)], memory: [], disk: [] }, NOW);
  assert.equal(stale.status, 'stale'); assert.equal(stale.cpuPercent, null);
  assert.equal(nativeMetrics({ cpu: [t('2%', new Date(NOW + 60000).toISOString())] }, NOW).status, 'unknown');
  assert.equal(nativeMetrics({}, NOW).status, 'no_data');
  const invalid = nativeMetrics({ cpu: [t('101%')], memory: [t({ used: '0GiB', total: '0GiB' })], disk: [t({ diskUsage: '', diskTotal: 0 })] }, NOW);
  assert.equal(invalid.ramTotalBytes, null); assert.equal(invalid.cpuPercent, null); assert.equal(invalid.storageTotalBytes, null);
  const partial = data(); partial.disk[0].time = old;
  assert.equal(nativeMetrics(partial, NOW).storageUsedBytes, null); assert.equal(nativeMetrics(partial, NOW).status, 'available');
});
test('Native shared WS : header secret, URL fixe appName dokploy, cache frais, backoff et fermeture', () => {
  const f = socketFactory(); let now = NOW;
  const n = new NativeDokploy({ url: 'https://d.example.test', apiKey: 'FAKE_KEY', now: () => now, createSocket: f.createSocket });
  n.watch(); n.watch(); assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].opts.headers['x-api-key'], 'FAKE_KEY'); assert.ok(!String(f.calls[0].url).includes('FAKE_KEY')); assert.equal(f.calls[0].url.searchParams.get('appName'), 'dokploy');
  f.calls[0].socket.emit('message', Buffer.from(JSON.stringify({ data: Object.fromEntries(Object.entries(data()).filter(([k]) => ['cpu','memory','disk'].includes(k)).map(([k,v]) => [k,v[0]])) })));
  assert.equal(n.current().monitoringMode, 'stream');
  f.calls[0].socket.terminate(); n.watch(); assert.equal(f.calls.length, 1); now += 5001; n.watch(); assert.equal(f.calls.length, 2);
  now += 300001; assert.equal(n.current(), null); n.close(); n.watch(); assert.equal(f.calls.length, 2); assert.equal(f.calls[1].socket.closed, true);
});
test('Native logs rejects arbitrary paths, traversal, shell injection, serverId injection without a socket', async () => {
  const f = socketFactory(); const n = new NativeDokploy({ url: 'https://d.example.test', apiKey: 'FAKE_KEY', createSocket: f.createSocket });
  for (const p of ['/etc/passwd', '/etc/dokploy/logs/../x.log','/etc/dokploy/logs/x.log;touch','/etc/dokploy/logs/x.log\n','file:///etc/dokploy/logs/x.log']) assert.equal((await n.logs(p,null)).state, 'unsupported');
  assert.equal((await n.logs('/etc/dokploy/logs/a/x.log', 'x&secret=y')).state, 'unsupported'); assert.equal(f.calls.length, 0); n.close();
});
test('Native logs bounded authenticated stream, never forward remote error, clean up', async () => {
  const f = socketFactory(); const n = new NativeDokploy({ url: 'https://d.example.test', apiKey: 'FAKE_KEY', createSocket: f.createSocket });
  const p = n.logs('/etc/dokploy/logs/a/build-2026-10-01T10:45:30.log', null); assert.equal(f.calls[0].url.pathname, '/listen-deployment');
  f.calls[0].socket.emit('message', Buffer.from('Build completed')); f.calls[0].socket.terminate(); assert.equal((await p).text, 'Build completed');
  const err = n.logs('/etc/dokploy/logs/a/x.log', null); f.calls[1].socket.emit('message', Buffer.from('tail error: /SECRET_PATH denied')); assert.equal((await err).text, null);
  const big = n.logs('/etc/dokploy/logs/a/x.log', null); f.calls[2].socket.emit('message', Buffer.from('x'.repeat(300000))); const r = await big; assert.equal(r.truncated, true); assert.ok(r.text.length <= 65536); assert.equal(f.calls[2].socket.closed, true); n.close();
});
test('0.26.5 fallback REST native without any agent port request; exact host appName; secret stays backend', async () => {
  const fetch = fakeFetch([[/user.getMetricsToken/, () => ({json:{serverIp:'127.0.0.1',metricsConfig:{server:{port:4500,token:'',urlCallback:''}}}})], [/application.readAppMonitoring/, () => ({json:data()})]]);
  const client = new DokployClient({url:'https://d.example.test',apiKey:'FAKE_KEY'}, {fetch,now:()=>NOW}); client.versionCache = { value:'v0.26.5' };
  const r = await client.hostMetrics(NOW+20000, Promise.resolve(detectCapabilities('v0.26.5', null)));
  assert.equal(r.status,'available'); assert.equal(r.source,'dokploy_native'); assert.equal(fetch.calls.length,2);
  assert.equal(new URL(fetch.calls[1].url).searchParams.get('appName'),'dokploy'); assert.ok(!JSON.stringify(r).includes('FAKE_KEY')); client.close();
});
test('0.26.5 logs deploymentId binding, whitelist outputs, mask credentials and never expose path', async () => {
  const f = socketFactory(); const client = new DokployClient({url:'https://d.example.test',apiKey:'FAKE_KEY'}, {fetch:fakeFetch([]),now:()=>NOW,createSocket:f.createSocket});
  client.versionCache = { value:'v0.26.5', at:NOW }; client.schemaCache = {until:NOW+10000,paths:new Set(['deployment.all'])};
  client.remember('d1',{serviceId:'a',logPath:'/etc/dokploy/logs/a/x.log',serverId:null,dokployUrl:'https://d.example.test/dashboard/project/p/environment/e/services/application/a?tab=deployments'});
  const p = client.logs('d1'); await new Promise((r)=>setImmediate(r));
  f.calls[0].socket.emit('message', Buffer.from('build start\nPASSWORD=private-value\nbuild done')); f.calls[0].socket.terminate(); const r = await p;
  assert.equal(r.available,true); assert.equal(r.transport,'websocket'); assert.ok(!JSON.stringify(r).includes('private-value')); assert.ok(!JSON.stringify(r).includes('/etc/dokploy/logs')); assert.ok(r.logs.includes('build done'));
  await assert.rejects(client.logs('../d1')); client.close();
});

test('Logs auth failure is classified without response body, arbitrary project secrets masked in free text', async () => {
  const f = socketFactory(); const n = new NativeDokploy({ url: 'https://d.example.test', apiKey: 'FAKE_KEY', createSocket: f.createSocket });
  const p = n.logs('/etc/dokploy/logs/a/x.log', null); f.calls[0].socket.emit('unexpected-response', null, {statusCode:403,resume(){}});
  assert.equal((await p).state,'permission'); n.close();
  const client = new DokployClient({url:'https://d.example.test',apiKey:'FAKE_KEY'}, {fetch:fakeFetch([])});
  client.rememberSecrets({environments:[{applications:[{env:'CUSTOM_SETTING="arbitrary-sensitive-value"\nSMALL_SECRET=abcd',password:'hidden-password'}]}]});
  const safe = client.cleanLogs('output arbitrary-sensitive-value abcd hidden-password FAKE_KEY');
  assert.ok(!safe.text.includes('arbitrary-sensitive-value')); assert.ok(!safe.text.includes('abcd')); assert.ok(!safe.text.includes('hidden-password')); assert.ok(!safe.text.includes('FAKE_KEY')); client.close();
});
