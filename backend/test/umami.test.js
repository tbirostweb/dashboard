// Analytics Umami : configuration, normalisation (formats v2 et anciens), authentification, erreurs, secrets.
import test from 'node:test';
import assert from 'node:assert/strict';
import { UmamiClient, umamiMissing } from '../src/umami.js';
import { loadConfig } from '../src/config.js';
import { makeApp, fakeFetch, testConfig, TEST_PASSWORD } from './helpers.js';

const ID = '11111111-2222-3333-4444-555555555555';
const base = { baseUrl: 'https://umami.example.test', websiteId: ID, apiKey: '', username: 'admin', password: 'pw-de-test-umami', timezone: 'Europe/Paris', cacheSeconds: 0 };
const json = (j, status = 200) => () => ({ status, json: j });
const STATS = { pageviews: { value: 300, prev: 200 }, visitors: { value: 100, prev: 80 }, visits: { value: 120, prev: 100 }, bounces: { value: 60, prev: 40 }, totaltime: { value: 12000, prev: 8000 } };
const routes = (over = []) => [
  ...over,
  [/\/auth\/login/, json({ token: 'tok-1' })],
  [/\/stats\?/, json(STATS)],
  [/\/pageviews\?/, json({ pageviews: [{ x: '2026-10-01 00:00:00', y: 5 }], sessions: [{ x: '2026-10-01 00:00:00', y: 3 }] })],
  [/type=referrer/, json([{ x: 'google.com', y: 40 }, { x: '', y: 10 }])],
  [/type=path/, json([{ x: '/', y: 90 }])],
  [/\/active/, json({ visitors: 2 })]
];

test('umamiMissing liste les variables manquantes', () => {
  assert.deepEqual(umamiMissing({}), ['UMAMI_BASE_URL', 'UMAMI_WEBSITE_ID', 'UMAMI_API_KEY (ou UMAMI_USERNAME + UMAMI_PASSWORD)']);
  assert.deepEqual(umamiMissing(base), []);
  assert.equal(loadConfig({ UMAMI_BASE_URL: 'javascript:alert(1)' }).umami.baseUrl, '');
  assert.equal(loadConfig({ UMAMI_BASE_URL: 'https://u.example/' }).umami.baseUrl, 'https://u.example');
});

test('rapport : totaux, variations, temps moyen et rebond dérivés, listes', async () => {
  const f = fakeFetch(routes());
  const r = await new UmamiClient(base, { fetch: f }).report('30d');
  assert.equal(r.totals.visitors.value, 100);
  assert.equal(r.totals.visitors.previous, 80);
  assert.equal(r.totals.avgVisitSeconds.value, 100);
  assert.equal(r.totals.bounceRate.value, 50);
  assert.equal(r.totals.bounceRate.previous, 40);
  assert.equal(r.active, 2);
  assert.deepEqual(r.referrers[0], { label: 'google.com', value: 40 });
  assert.equal(r.series[0].date, '2026-10-01');
  assert.ok(f.calls.every((c) => c.url.startsWith('https://umami.example.test/api/')), 'auto-hébergé : /api');
  assert.ok(f.calls.filter((c) => !/auth\/login/.test(c.url)).every((c) => c.init.headers.Authorization === 'Bearer tok-1'));
});

test('Umami Cloud : clé API, préfixe /v1, aucun login', async () => {
  const f = fakeFetch(routes());
  await new UmamiClient({ ...base, baseUrl: 'https://api.umami.is', apiKey: 'cle-api-de-test', username: '', password: '' }, { fetch: f }).report('7d');
  assert.ok(f.calls.every((c) => c.url.startsWith('https://api.umami.is/v1/websites/')));
  assert.ok(f.calls.every((c) => c.init.headers['x-umami-api-key'] === 'cle-api-de-test'));
});

test('anciennes versions : nombres bruts + comparison ; path refusé → repli sur url', async () => {
  const f = fakeFetch(routes([
    [/\/stats\?/, json({ pageviews: 30, visitors: 10, visits: 20, bounces: 10, totaltime: 2000, comparison: { pageviews: 15, visitors: 5, visits: 10, bounces: 5, totaltime: 500 } })],
    [/type=path/, json({ error: 'bad' }, 400)],
    [/type=url/, json([{ x: '/a', y: 3 }])]
  ]));
  const r = await new UmamiClient(base, { fetch: f }).report('30d');
  assert.equal(r.totals.pageviews.value, 30);
  assert.equal(r.totals.pageviews.previous, 15);
  assert.equal(r.totals.avgVisitSeconds.previous, 50);
  assert.deepEqual(r.pages, [{ label: '/a', value: 3 }]);
});

test('une section en échec n’empêche pas le reste ; stats en échec → erreur sans secret', async () => {
  const partial = await new UmamiClient(base, { fetch: fakeFetch(routes([[/type=referrer/, json({}, 500)], [/\/active/, json({}, 500)]])) }).report('30d');
  assert.equal(partial.referrers, null);
  assert.equal(partial.active, null);
  assert.equal(partial.pages.length, 1);
  await assert.rejects(new UmamiClient(base, { fetch: fakeFetch(routes([[/\/stats\?/, json({ message: 'nope' }, 500)]])) }).report('30d'), (e) => !/pw-de-test|tok-1/.test(e.message) && e.status === 500);
  await assert.rejects(new UmamiClient({ ...base, websiteId: '../x' }, { fetch: fakeFetch([]) }).report('30d'), /UUID/);
});

test('jeton expiré : une reconnexion puis succès', async () => {
  let n = 0;
  const f = fakeFetch(routes([[/\/stats\?/, () => (n++ === 0 ? { status: 401, json: {} } : { json: STATS })]]));
  const r = await new UmamiClient(base, { fetch: f }).report('30d');
  assert.equal(r.totals.visits.value, 120);
  assert.equal(f.calls.filter((c) => /auth\/login/.test(c.url)).length, 2);
});

test('GET /api/analytics : non configuré, ok, erreur 401 ; protégé par la session', async () => {
  const login = async (app) => {
    const r = await app.inject({ method: 'POST', url: '/api/auth/login', headers: { origin: 'https://dash.example.test' }, payload: { password: TEST_PASSWORD } });
    return r.headers['set-cookie'].map((c) => c.split(';')[0]).join('; ');
  };
  const off = makeApp();
  assert.equal((await off.app.inject({ method: 'GET', url: '/api/analytics' })).statusCode, 401);
  const c1 = await login(off.app);
  const r1 = (await off.app.inject({ method: 'GET', url: '/api/analytics', headers: { cookie: c1 } })).json();
  assert.equal(r1.status, 'not_configured');
  assert.equal(r1.missing.length, 3);

  const cfg = testConfig({ UMAMI_BASE_URL: base.baseUrl, UMAMI_WEBSITE_ID: ID, UMAMI_API_KEY: 'cle-api-de-test' });
  const on = makeApp({ cfg });
  const body = await (async () => {
    const c = await login(on.app);
    return (await on.app.inject({ method: 'GET', url: '/api/analytics?range=zzz', headers: { cookie: c } })).json();
  })();
  // Sans faux fetch injecté pour Umami, l'appel réel échoue proprement (réseau) en « error », sans fuite de secret.
  assert.equal(body.status, 'error');
  assert.ok(!JSON.stringify(body).includes('cle-api-de-test'));
});
