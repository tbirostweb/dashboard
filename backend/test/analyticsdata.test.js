// Google Analytics 4 (API Analytics Data) : configuration, JWT du compte de service, normalisation, erreurs, secrets.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { AnalyticsDataClient, ga4Missing, ga4PropertyId } from '../src/analyticsdata.js';
import { loadConfig } from '../src/config.js';
import { fakeFetch, makeApp, testConfig, TEST_PASSWORD } from './helpers.js';

const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
const gsc = { clientEmail: 'dash@projet.iam.gserviceaccount.com', privateKey };
const ga4 = { propertyId: '123456789', cacheSeconds: 0 };
const NOW = Date.parse('2026-10-18T12:00:00Z');
const json = (j, status = 200) => () => ({ status, json: j });
const mv = (...v) => v.map((value) => ({ value: String(value) }));
const body = (i) => JSON.parse(i.body);
const routes = (over = []) => [
  ...over,
  [(u, i) => /runReport/.test(u) && body(i).dimensionFilter, json({ rows: [{ dimensionValues: [{ value: 'cta_devis_click' }], metricValues: mv(9, 7) }] })],
  [/oauth2\.googleapis\.com\/token/, json({ access_token: 'ya29.token-de-test', expires_in: 3600 })],
  [(u, i) => /runReport/.test(u) && body(i).dimensions?.[0]?.name === 'date', json({ rows: [{ dimensionValues: [{ value: '20261016' }], metricValues: mv(4, 6, 12) }] })],
  [(u, i) => /runReport/.test(u) && body(i).dimensions?.[0]?.name === 'pagePath', json({ rows: [{ dimensionValues: [{ value: '/services' }], metricValues: mv(30, 9) }] })],
  [(u, i) => /runReport/.test(u) && body(i).dimensions?.[0]?.name === 'eventName', json({ rows: [{ dimensionValues: [{ value: 'click_devis' }], metricValues: mv(7, 5) }] })],
  [(u, i) => /runReport/.test(u) && body(i).dimensions?.[0]?.name === 'sessionSource', json({ rows: [{ dimensionValues: [{ value: 'google' }], metricValues: mv(50, 40) }] })],
  [(u, i) => /runReport/.test(u) && !body(i).dimensions, (u, i) => ({ json: { rows: [{ metricValues: body(i).dateRanges[0].startDate < '2026-09-01' ? mv(10, 12, 40, 100) : mv(20, 25, 90, 260) }] } })]
];

test('configuration : identifiant numérique de propriété (jamais l’identifiant de mesure G-…), variables manquantes', () => {
  assert.equal(ga4PropertyId('123456789'), '123456789');
  assert.equal(ga4PropertyId('properties/123456789'), '123456789');
  assert.equal(ga4PropertyId('G-5MVJ5K3QXZ'), '');
  assert.deepEqual(ga4Missing({}, {}), ['GA4_PROPERTY_ID', 'GSC_CLIENT_EMAIL', 'GSC_PRIVATE_KEY']);
  assert.deepEqual(ga4Missing(gsc, ga4), []);
  assert.equal(loadConfig({ GA4_PROPERTY_ID: 'G-5MVJ5K3QXZ' }).ga4.propertyId, '');
});

test('rapport : portée analytics.readonly, totaux et variation, série complétée, pages et événements', async () => {
  const f = fakeFetch(routes());
  const r = await new AnalyticsDataClient(gsc, ga4, { fetch: f, now: () => NOW }).report('30d');
  assert.equal(r.totals.users.value, 20);
  assert.equal(r.totals.users.previous, 10);
  assert.equal(r.totals.events.value, 260);
  assert.equal(r.series.length, 30);
  assert.equal(r.series.find((p) => p.date === '2026-10-16').pageviews, 12);
  assert.equal(r.series.find((p) => p.date === '2026-10-15').users, 0);
  assert.deepEqual(r.pages[0], { path: '/services', views: 30, users: 9 });
  assert.deepEqual(r.events[0], { name: 'click_devis', count: 7, users: 5 });
  assert.deepEqual(r.sources[0], { source: 'google', sessions: 50, users: 40 });
  assert.equal(r.siteEvents.length, 5);
  assert.deepEqual(r.siteEvents[0], { name: 'cta_devis_click', count: 9, users: 7 });
  assert.deepEqual(r.siteEvents.slice(1).map((x) => x.count), [0, 0, 0, 0], 'événements absents = zéro');
  const tokenCall = f.calls.find((c) => /oauth2/.test(c.url));
  const [h, p, s] = new URLSearchParams(tokenCall.init.body).get('assertion').split('.');
  assert.ok(crypto.createVerify('RSA-SHA256').update(`${h}.${p}`).verify(crypto.createPublicKey(privateKey), s, 'base64url'));
  assert.equal(JSON.parse(Buffer.from(p, 'base64url')).scope, 'https://www.googleapis.com/auth/analytics.readonly');
  assert.ok(f.calls.filter((c) => /runReport/.test(c.url)).every((c) => c.url.includes('/properties/123456789:runReport') && c.init.headers.Authorization === 'Bearer ya29.token-de-test'));
});

test('aucune ligne = aucune activité (zéros) ; une section en échec n’empêche pas le reste', async () => {
  const empty = await new AnalyticsDataClient(gsc, ga4, { fetch: fakeFetch(routes([[(u, i) => /runReport/.test(u) && !body(i).dimensions, json({})]])), now: () => NOW }).report('7d');
  assert.equal(empty.totals.users.value, 0);
  const partial = await new AnalyticsDataClient(gsc, ga4, { fetch: fakeFetch(routes([[(u, i) => /runReport/.test(u) && body(i).dimensions?.[0]?.name === 'eventName', json({}, 500)]])), now: () => NOW }).report('7d');
  assert.equal(partial.events, null);
  assert.equal(partial.pages.length, 1);
});

test('GET /api/ga4 : protégé, non configuré, messages d’erreur précis sans secret', async () => {
  const off = makeApp();
  assert.equal((await off.app.inject({ method: 'GET', url: '/api/ga4' })).statusCode, 401);
  const login = async (app) => (await app.inject({ method: 'POST', url: '/api/auth/login', headers: { origin: 'https://dash.example.test' }, payload: { password: TEST_PASSWORD } })).headers['set-cookie'].map((c) => c.split(';')[0]).join('; ');
  const c0 = await login(off.app);
  const nc = (await off.app.inject({ method: 'GET', url: '/api/ga4', headers: { cookie: c0 } })).json();
  assert.equal(nc.status, 'not_configured');
  assert.ok(nc.missing.includes('GA4_PROPERTY_ID'));

  const ask = async (status, message) => {
    const cfg = testConfig({ GA4_PROPERTY_ID: '123456789', GSC_CLIENT_EMAIL: gsc.clientEmail, GSC_PRIVATE_KEY: privateKey.replace(/\n/g, '\\n') });
    const f = fakeFetch([[/oauth2\.googleapis\.com\/token/, json({ access_token: 'ya29.x', expires_in: 3600 })], [/runReport/, json({ error: { code: status, message } }, status)]]);
    const { app } = makeApp({ cfg, analyticsData: new AnalyticsDataClient(cfg.gsc, cfg.ga4, { fetch: f, now: () => NOW }) });
    const cookie = await login(app);
    return (await app.inject({ method: 'GET', url: '/api/ga4', headers: { cookie } })).json();
  };
  assert.match((await ask(403, 'Google Analytics Data API has not been used in project 1 before or it is disabled.')).message, /pas activée/);
  const perm = await ask(403, 'User does not have sufficient permissions for this property.');
  assert.match(perm.message, /Lecteur/);
  assert.match(perm.message, /dash@projet\.iam\.gserviceaccount\.com/);
  assert.match((await ask(400, 'Invalid property ID')).message, /NUMÉRIQUE/);
  assert.ok(!JSON.stringify(perm).includes('BEGIN PRIVATE KEY'));
});
