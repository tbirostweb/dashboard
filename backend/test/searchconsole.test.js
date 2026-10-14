// SEO (Google Search Console) : configuration, JWT du compte de service, normalisation, erreurs, secrets.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { SearchConsoleClient, gscMissing, gscSiteUrl, gscPrivateKey } from '../src/searchconsole.js';
import { loadConfig } from '../src/config.js';
import { fakeFetch, makeApp, testConfig, TEST_PASSWORD } from './helpers.js';

const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
const cfg = { siteUrl: 'sc-domain:birostweb.fr', clientEmail: 'dash@projet.iam.gserviceaccount.com', privateKey, cacheSeconds: 0 };
const json = (j, status = 200) => () => ({ status, json: j });
const NOW = Date.parse('2026-10-12T12:00:00Z');
const row = (keys, clicks, impressions, ctr, position) => ({ keys, clicks, impressions, ctr, position });
const routes = (over = []) => [
  ...over,
  [/oauth2\.googleapis\.com\/token/, json({ access_token: 'ya29.token-de-test', expires_in: 3600 })],
  [(u, i) => /searchAnalytics\/query/.test(u) && JSON.parse(i.body).dimensions?.[0] === 'date', json({ rows: [row(['2026-10-09'], 3, 100, 0.03, 8)] })],
  [(u, i) => /searchAnalytics\/query/.test(u) && JSON.parse(i.body).dimensions?.[0] === 'query', json({ rows: [row(['birostweb'], 5, 50, 0.1, 2.4)] })],
  [(u, i) => /searchAnalytics\/query/.test(u) && JSON.parse(i.body).dimensions?.[0] === 'page', json({ rows: [row(['https://birostweb.fr/services'], 4, 80, 0.05, 6)] })],
  [(u, i) => /searchAnalytics\/query/.test(u) && !JSON.parse(i.body).dimensions, (u, i) => ({ json: { rows: [JSON.parse(i.body).startDate < '2026-08-31' ? { clicks: 10, impressions: 200, ctr: 0.05, position: 9 } : { clicks: 20, impressions: 400, ctr: 0.05, position: 7.5 }] } })]
];

test('configuration : variables manquantes, propriété valide, clé PEM sur une ligne', () => {
  assert.deepEqual(gscMissing({}), ['GSC_SITE_URL', 'GSC_CLIENT_EMAIL', 'GSC_PRIVATE_KEY']);
  assert.deepEqual(gscMissing(cfg), []);
  assert.equal(gscSiteUrl('sc-domain:birostweb.fr'), 'sc-domain:birostweb.fr');
  assert.equal(gscSiteUrl('https://birostweb.fr/'), 'https://birostweb.fr/');
  assert.equal(gscSiteUrl('javascript:alert(1)'), '');
  assert.equal(gscPrivateKey('-----BEGIN PRIVATE KEY-----\\nABC\\n-----END PRIVATE KEY-----'), '-----BEGIN PRIVATE KEY-----\nABC\n-----END PRIVATE KEY-----');
  assert.equal(loadConfig({ GSC_SITE_URL: 'pas une url' }).gsc.siteUrl, '');
});

test('rapport : JWT RS256 valide, totaux et variation, série complétée, listes', async () => {
  const f = fakeFetch(routes());
  const r = await new SearchConsoleClient(cfg, { fetch: f, now: () => NOW }).report('30d');
  assert.equal(r.totals.clicks.value, 20);
  assert.equal(r.totals.clicks.previous, 10);
  assert.equal(r.totals.ctr.value, 5);
  assert.equal(r.totals.position.previous, 9);
  assert.equal(r.series.length, 30, 'un point par jour, jours sans ligne = 0');
  assert.equal(r.series.find((p) => p.date === '2026-10-09').clicks, 3);
  assert.equal(r.series.find((p) => p.date === '2026-10-08').impressions, 0);
  assert.deepEqual(r.queries[0], { query: 'birostweb', clicks: 5, impressions: 50, ctr: 10, position: 2.4 });
  assert.equal(r.pages[0].page, 'https://birostweb.fr/services');
  // JWT : signature vérifiable avec la clé publique, claims attendus
  const tokenCall = f.calls.find((c) => /oauth2/.test(c.url));
  const assertion = new URLSearchParams(tokenCall.init.body).get('assertion');
  const [h, p, s] = assertion.split('.');
  const pub = crypto.createPublicKey(privateKey);
  assert.ok(crypto.createVerify('RSA-SHA256').update(`${h}.${p}`).verify(pub, s, 'base64url'));
  const claim = JSON.parse(Buffer.from(p, 'base64url'));
  assert.equal(claim.iss, cfg.clientEmail);
  assert.equal(claim.scope, 'https://www.googleapis.com/auth/webmasters.readonly');
  assert.ok(f.calls.filter((c) => /searchAnalytics/.test(c.url)).every((c) => c.init.headers.Authorization === 'Bearer ya29.token-de-test'));
  assert.equal(f.calls.filter((c) => /oauth2/.test(c.url)).length, 1, 'un seul jeton pour toutes les requêtes simultanées');
});

test('aucune ligne = zéro impression ; section en échec n’empêche pas le reste', async () => {
  const empty = await new SearchConsoleClient(cfg, { fetch: fakeFetch(routes([[(u, i) => /searchAnalytics/.test(u) && !JSON.parse(i.body).dimensions, json({})]])), now: () => NOW }).report('7d');
  assert.equal(empty.totals.clicks.value, 0);
  assert.equal(empty.totals.ctr.value, null);
  const partial = await new SearchConsoleClient(cfg, { fetch: fakeFetch(routes([[(u, i) => /searchAnalytics/.test(u) && JSON.parse(i.body).dimensions?.[0] === 'query', json({}, 500)]])), now: () => NOW }).report('7d');
  assert.equal(partial.queries, null);
  assert.equal(partial.pages.length, 1);
});

test('erreurs sans secret : clé illisible, jeton refusé, accès refusé', async () => {
  await assert.rejects(new SearchConsoleClient({ ...cfg, privateKey: 'pas-une-cle' }, { fetch: fakeFetch([]), now: () => NOW }).report('7d'), (e) => e.code === 'config' && !/pas-une-cle/.test(e.message));
  await assert.rejects(new SearchConsoleClient(cfg, { fetch: fakeFetch(routes([[/oauth2/, json({ error: 'invalid_grant', error_description: 'Invalid JWT Signature.' }, 400)]])), now: () => NOW }).report('7d'), (e) => e.stage === 'token' && e.code === 'auth');
  await assert.rejects(new SearchConsoleClient(cfg, { fetch: fakeFetch(routes([[(u, i) => /searchAnalytics/.test(u) && !JSON.parse(i.body).dimensions, json({ error: { message: 'forbidden' } }, 403)]])), now: () => NOW }).report('7d'), (e) => e.status === 403 && !/ya29|BEGIN/.test(e.message));
});

test('GET /api/seo : protégé, non configuré, jamais de secret dans la réponse', async () => {
  const off = makeApp();
  assert.equal((await off.app.inject({ method: 'GET', url: '/api/seo' })).statusCode, 401);
  const lg = await off.app.inject({ method: 'POST', url: '/api/auth/login', headers: { origin: 'https://dash.example.test' }, payload: { password: TEST_PASSWORD } });
  const cookie = lg.headers['set-cookie'].map((c) => c.split(';')[0]).join('; ');
  const body = (await off.app.inject({ method: 'GET', url: '/api/seo', headers: { cookie } })).json();
  assert.equal(body.status, 'not_configured');
  assert.equal(body.missing.length, 3);
  void testConfig;
});

test('GET /api/seo : le 403 de Google distingue API désactivée et accès à la propriété', async () => {
  const ask = async (message) => {
    const env = { GSC_SITE_URL: 'sc-domain:birostweb.fr', GSC_CLIENT_EMAIL: 'dash@projet.iam.gserviceaccount.com', GSC_PRIVATE_KEY: privateKey.replace(/\n/g, '\\n') };
    const f = fakeFetch([
      [/oauth2\.googleapis\.com\/token/, json({ access_token: 'ya29.x', expires_in: 3600 })],
      [/searchAnalytics/, json({ error: { code: 403, message } }, 403)]
    ]);
    const cfg = testConfig(env);
    const { app } = makeApp({ cfg, searchConsole: new SearchConsoleClient(cfg.gsc, { fetch: f, now: () => NOW }) });
    const lg = await app.inject({ method: 'POST', url: '/api/auth/login', headers: { origin: 'https://dash.example.test' }, payload: { password: TEST_PASSWORD } });
    const cookie = lg.headers['set-cookie'].map((c) => c.split(';')[0]).join('; ');
    return (await app.inject({ method: 'GET', url: '/api/seo', headers: { cookie } })).json();
  };
  const api = await ask('Google Search Console API has not been used in project 123 before or it is disabled.');
  assert.equal(api.status, 'error');
  assert.match(api.message, /pas activée/);
  const perm = await ask("User does not have sufficient permission for site 'sc-domain:birostweb.fr'.");
  assert.match(perm.message, /n’a pas accès à la propriété « sc-domain:birostweb\.fr »/);
  assert.match(perm.message, /dash@projet\.iam\.gserviceaccount\.com/);
  assert.ok(!JSON.stringify([api, perm]).includes('BEGIN PRIVATE KEY'));
  const other = await ask('Quelque chose d’autre');
  assert.match(other.message, /Accès refusé par Google/);
});
