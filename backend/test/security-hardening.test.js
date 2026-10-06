// Durcissement (audit 10/2026) : sessions révocables, CSRF strict, proxy de confiance,
// avertissements de configuration, liste blanche Dokploy, journaux désactivables. Valeurs FACTICES uniquement.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeApp, login, testConfig, TEST_PASSWORD, TEST_SECRET, fakeFetch } from './helpers.js';
import { SessionRegistry, createSession } from '../src/security.js';
import { assertSecrets, securityWarnings, ConfigError } from '../src/config.js';
import { DokployClient, DokployError } from '../src/dokploy.js';

const ORIGIN = 'https://dash.example.test';
const REDEPLOY = '/api/infrastructure/services/application/a/redeploy';

// ------------------------------------------------------------------ Sessions
test('Session : cookie copié refusé après déconnexion ; logout-all révoque toutes les sessions', async () => {
  const { app } = makeApp();
  const a = await login(app);
  const b = await login(app);
  assert.equal((await app.inject({ url: '/api/status', headers: { cookie: a } })).statusCode, 200);
  const out = await app.inject({ method: 'POST', url: '/api/auth/logout', headers: { origin: ORIGIN, cookie: a } });
  assert.equal(out.statusCode, 200);
  assert.equal((await app.inject({ url: '/api/status', headers: { cookie: a } })).statusCode, 401, 'copie du cookie révoquée côté serveur');
  assert.equal((await app.inject({ url: '/api/auth/session', headers: { cookie: a } })).json().authenticated, false);
  assert.equal((await app.inject({ url: '/api/status', headers: { cookie: b } })).statusCode, 200, 'autre session intacte');
  const all = await app.inject({ method: 'POST', url: '/api/auth/logout-all', headers: { origin: ORIGIN, cookie: b } });
  assert.equal(all.statusCode, 200);
  assert.equal((await app.inject({ url: '/api/status', headers: { cookie: b } })).statusCode, 401);
  assert.equal((await app.inject({ method: 'POST', url: '/api/auth/logout-all', headers: { origin: ORIGIN } })).statusCode, 401, 'logout-all exige une session');
});

test('Session : jeton signé valide mais inconnu du registre (redémarrage / rotation) refusé ; expiré et altéré refusés', async () => {
  let t = Date.now();
  const { app } = makeApp({ now: () => t });
  const forged = `sd_session=${encodeURIComponent(createSession(TEST_SECRET, 3_600_000, t))}`;
  assert.equal((await app.inject({ url: '/api/status', headers: { cookie: forged } })).statusCode, 401, 'non émis par cette instance');
  const cookie = await login(app);
  assert.equal((await app.inject({ url: '/api/status', headers: { cookie: cookie.slice(0, -3) + 'abc' } })).statusCode, 401, 'signature altérée');
  t += 12 * 3_600_000 + 1;
  assert.equal((await app.inject({ url: '/api/status', headers: { cookie } })).statusCode, 401, 'expiré');
});

test('SessionRegistry : expiration, révocation, borne du nombre de sessions', () => {
  let t = 0;
  const r = new SessionRegistry({ max: 2, now: () => t });
  r.add('a', 100); r.add('b', 100); r.add('c', 100);
  assert.equal(r.has('a'), false, 'plus ancienne évincée');
  assert.equal(r.has('b') && r.has('c'), true);
  r.revoke('b'); assert.equal(r.has('b'), false);
  t = 100; assert.equal(r.has('c'), false, 'expirée');
  assert.equal(r.size, 0);
});

test('SESSION_TTL_HOURS borné à 24 h', () => {
  assert.equal(testConfig({ SESSION_TTL_HOURS: '720' }).sessionTtlHours, 24);
  assert.equal(testConfig({ SESSION_TTL_HOURS: '0' }).sessionTtlHours, 1);
});

// ------------------------------------------------------------------ Actions d'infrastructure (mot de passe seul, sans second facteur)
function dokployFixture() {
  const project = () => ({ projectId: 'p1', name: 'Alpha', environments: [{ environmentId: 'e1', name: 'production', applications: [{ applicationId: 'a', name: 'app', appName: 'app-a', applicationStatus: 'done' }], compose: [] }] });
  const fetch = fakeFetch([
    [/settings.getDokployVersion/, () => ({ json: 'v0.30.8' })],
    [/settings.getOpenApiDocument/, () => ({ status: 404, json: {} })],
    [/project.all/, () => ({ json: [project()] })],
    [/project.one/, () => ({ json: project() })],
    [/deployment.all/, () => ({ json: [] })],
    [/application.redeploy/, () => ({ body: '' })],
    [/application.reload/, () => ({ json: true })],
    [/user.getMetricsToken/, () => ({ json: { serverIp: '127.0.0.1', metricsConfig: { server: { port: 4500, token: '' } } } })]
  ]);
  return fetch;
}

// ------------------------------------------------------------------ CSRF / proxy / en-têtes
test('CSRF : mutation sans Origin ni Sec-Fetch-Site refusée ; same-origin accepté ; Origin exact + same-site refusé', async () => {
  const { app } = makeApp();
  const cookie = await login(app);
  const ping = (headers) => app.inject({ method: 'POST', url: '/api/live/ping', headers: { cookie, ...headers }, payload: {} });
  assert.equal((await ping({})).statusCode, 403, 'aucune preuve d’origine');
  assert.equal((await ping({ 'sec-fetch-site': 'same-origin' })).statusCode, 204);
  assert.equal((await ping({ origin: ORIGIN })).statusCode, 204);
  assert.equal((await ping({ origin: ORIGIN, 'sec-fetch-site': 'same-site' })).statusCode, 403);
  assert.equal((await ping({ origin: 'null' })).statusCode, 403);
});

test('Proxy de confiance : X-Forwarded-For ignoré depuis une adresse publique (anti brute-force non contournable)', async () => {
  const { app } = makeApp({ env: { LOGIN_MAX_ATTEMPTS: '2' } });
  const fail = (xff, remoteAddress) => app.inject({ method: 'POST', url: '/api/auth/login', remoteAddress, headers: { origin: ORIGIN, 'x-forwarded-for': xff }, payload: { password: 'faux' } });
  await fail('198.51.100.1', '203.0.113.9');
  await fail('198.51.100.2', '203.0.113.9');
  assert.equal((await fail('198.51.100.3', '203.0.113.9')).statusCode, 429, 'IP forgée sans effet : la même source reste bloquée');
  // Depuis le nginx interne (adresse privée), l'IP transmise est bien prise en compte (une autre IP n'est pas bloquée)
  assert.equal((await fail('198.51.100.4', '172.18.0.5')).statusCode, 401);
});

test('Connexion : mot de passe correct accepté avec Origin, ou sans Origin via Sec-Fetch-Site / Referer de même origine', async () => {
  const { app } = makeApp();
  const post = (headers) => app.inject({ method: 'POST', url: '/api/auth/login', headers, payload: { password: TEST_PASSWORD } });
  assert.equal((await post({ origin: ORIGIN })).statusCode, 200);
  assert.equal((await post({ 'sec-fetch-site': 'same-origin' })).statusCode, 200);
  assert.equal((await post({ referer: `${ORIGIN}/login.html` })).statusCode, 200, 'navigateur sans Origin ni Sec-Fetch-Site');
  const foreign = await post({ referer: 'https://evil.example/login.html' });
  assert.equal(foreign.statusCode, 403); assert.equal(foreign.json().error, 'forbidden_origin');
  assert.match(foreign.json().message, /PUBLIC_URL/, 'message d’origine explicite, distinct du mot de passe');
  assert.equal((await post({ origin: 'https://autre.example' })).statusCode, 403);
  assert.equal((await post({ origin: ORIGIN, 'sec-fetch-site': 'cross-site' })).statusCode, 403);
  assert.equal((await post({ referer: `${ORIGIN}/`, 'sec-fetch-site': 'cross-site' })).statusCode, 403);
});

test('Connexion derrière nginx/Traefik : visiteurs distincts non bloqués par les échecs d’un autre ; session conservée', async () => {
  const { app } = makeApp({ env: { LOGIN_MAX_ATTEMPTS: '2' } });
  const post = (xff, password) => app.inject({ method: 'POST', url: '/api/auth/login', remoteAddress: '172.18.0.5', headers: { origin: ORIGIN, 'x-forwarded-for': xff }, payload: { password } });
  for (let i = 0; i < 3; i++) await post('198.51.100.10', 'faux');
  assert.equal((await post('198.51.100.10', TEST_PASSWORD)).statusCode, 429, 'attaquant bloqué');
  const ok = await post('198.51.100.20', TEST_PASSWORD);
  assert.equal(ok.statusCode, 200, 'autre visiteur derrière le même proxy non bloqué');
  const cookie = String(ok.headers['set-cookie']).split(';')[0];
  assert.equal((await app.inject({ url: '/api/auth/session', headers: { cookie } })).json().authenticated, true, 'session enregistrée');
  assert.equal((await app.inject({ url: '/api/status', headers: { cookie } })).statusCode, 200);
});

test('Front : page de connexion sans champ de second facteur, cache-bust incrémenté', async () => {
  const fs = await import('node:fs');
  const html = fs.readFileSync(new URL('../../login.html', import.meta.url), 'utf8');
  const js = fs.readFileSync(new URL('../../js/login.js', import.meta.url), 'utf8');
  assert.ok(Number(html.match(/js\/login\.js\?v=(\d+)/)[1]) >= 17);
  assert.doesNotMatch(html + js, /totp|second_?factor|2FA/i);
});

test('API : X-Robots-Tag noindex sur toutes les réponses', async () => {
  const { app } = makeApp();
  assert.equal((await app.inject({ url: '/api/health' })).headers['x-robots-tag'], 'noindex, nofollow');
});

// ------------------------------------------------------------------ Configuration
test('Configuration : mot de passe identique à un secret refusé ; DASHBOARD_TOTP_SECRET résiduel ignoré ; avertissements sans valeur secrète', () => {
  assert.throws(() => assertSecrets(testConfig({ DASHBOARD_PASSWORD: TEST_SECRET })), /différent/);
  assert.doesNotThrow(() => assertSecrets(testConfig({ DASHBOARD_TOTP_SECRET: 'court' })), 'ancienne variable ignorée sans erreur');
  const w = securityWarnings(testConfig({ DASHBOARD_PASSWORD: 'motdepasseweak', DOKPLOY_URL: 'https://dokploy.example.test' }));
  assert.ok(w.some((m) => /phrase de passe/.test(m)));
  assert.ok(!w.join(' ').includes('motdepasseweak'), 'aucune valeur secrète');
  assert.deepEqual(securityWarnings(testConfig({ DASHBOARD_PASSWORD: 'Une-Longue-Phrase-De-Passe-Unique-42' })), []);
});

// ------------------------------------------------------------------ Dokploy : liste blanche, journaux
test('Dokploy : DOKPLOY_ACTION_ALLOWLIST restreint les actions (ID de service, ID ou nom de projet)', () => {
  const svc = { id: 'a', projectId: 'p1', projectName: 'Alpha' };
  assert.doesNotThrow(() => new DokployClient({}).assertActionAllowed(svc), 'vide = tous');
  for (const allow of [['a'], ['p1'], ['Alpha']]) assert.doesNotThrow(() => new DokployClient({ actionAllowlist: allow }).assertActionAllowed(svc));
  assert.throws(() => new DokployClient({ actionAllowlist: ['autre'] }).assertActionAllowed(svc), (e) => e instanceof DokployError && e.status === 403 && e.code === 'service_not_allowed');
  assert.deepEqual(testConfig({ DOKPLOY_ACTION_ALLOWLIST: ' a , Alpha ,' }).dokploy.actionAllowlist, ['a', 'Alpha']);
});

test('Dokploy : redéploiement hors liste blanche refusé (403) sans appel de mutation', async () => {
  const fetch = dokployFixture();
  const client = new DokployClient({ url: 'https://dokploy.example.test', apiKey: 'FAKE_DOKPLOY_KEY', actionAllowlist: ['Beta'] }, { fetch, sleep: async () => {} });
  await assert.rejects(client.redeploy('application', 'a', true), (e) => e.code === 'service_not_allowed');
  assert.equal(fetch.calls.filter((c) => /application.redeploy/.test(c.url)).length, 0);
});

test('Dokploy : DOKPLOY_LOGS_ENABLED=false -> aucun journal relu ; secrets propres de l’API masqués dans les journaux', async () => {
  const fetch = fakeFetch([]);
  const off = new DokployClient({ url: 'https://dokploy.example.test', apiKey: 'FAKE_DOKPLOY_KEY', logsEnabled: false }, { fetch });
  const r = await off.logs('dep1');
  assert.equal(r.state, 'unsupported'); assert.equal(r.logs, null); assert.equal(fetch.calls.length, 0);
  const cfg = testConfig({ DOKPLOY_API_KEY: 'FAKE_DOKPLOY_KEY_123', TIKTOK_CLIENT_SECRET: 'tt-secret-canari-xyz' });
  const c = new DokployClient(cfg.dokploy);
  const cleaned = c.cleanLogs(`build ok ${TEST_PASSWORD} puis tt-secret-canari-xyz et FAKE_DOKPLOY_KEY_123 fin`).text;
  for (const v of [TEST_PASSWORD, 'tt-secret-canari-xyz', 'FAKE_DOKPLOY_KEY_123', TEST_SECRET]) assert.ok(!cleaned.includes(v), 'secret masqué');
  assert.match(cleaned, /build ok .*fin/);
  assert.equal(testConfig({ DOKPLOY_LOGS_ENABLED: 'false' }).dokploy.logsEnabled, false);
});

// ------------------------------------------------------------------ HIBP (k-anonymity), hors réseau
test('check-password : seul le préfixe SHA-1 (5 caractères) est envoyé ; suffixe comparé localement', async () => {
  const { pwnedCount, HIBP_RANGE_URL } = await import('../scripts/check-password.js');
  const crypto = await import('node:crypto');
  const sha1 = crypto.createHash('sha1').update('mot-de-passe-factice').digest('hex').toUpperCase();
  const calls = [];
  const fetch = async (url) => { calls.push(String(url)); return new Response(`0000000000000000000000000000000000A:3\r\n${sha1.slice(5)}:42\r\n`, { status: 200 }); };
  assert.equal(await pwnedCount('mot-de-passe-factice', { fetch }), 42);
  assert.equal(calls[0], `${HIBP_RANGE_URL}${sha1.slice(0, 5)}`);
  assert.ok(!calls[0].includes(sha1.slice(5)) && !calls[0].includes('mot-de-passe'), 'ni mot de passe ni empreinte complète');
  assert.equal(await pwnedCount('autre-valeur-factice', { fetch }), 0);
  await assert.rejects(pwnedCount('x', { fetch: async () => new Response('', { status: 503 }) }), /HIBP indisponible/);
});

// ------------------------------------------------------------------ Non-régression : mot de passe seul
const noTrace = (body) => assert.doesNotMatch(String(body), /totp|second_?factor|2fa/i);

test('Connexion par mot de passe seul : 200 + cookie de session ; champs totp/code superflus ignorés ; aucune trace 2FA', async () => {
  const { app } = makeApp();
  const post = (payload) => app.inject({ method: 'POST', url: '/api/auth/login', headers: { origin: ORIGIN }, payload });
  const ok = await post({ password: TEST_PASSWORD });
  assert.equal(ok.statusCode, 200); assert.match(String(ok.headers['set-cookie']), /^sd_session=/); noTrace(ok.body);
  const extra = await post({ password: TEST_PASSWORD, totp: '123456', code: '654321' });
  assert.equal(extra.statusCode, 200, 'champ superflu ignoré'); assert.match(String(extra.headers['set-cookie']), /^sd_session=/);
  const bad = await post({ password: 'faux', totp: '123456' });
  assert.equal(bad.statusCode, 401); assert.equal(bad.json().error, 'invalid_password'); noTrace(bad.body);
  const session = await app.inject({ url: '/api/auth/session' });
  assert.deepEqual(session.json(), { authenticated: false }); noTrace(session.body);
});

test('Connexion : anti-brute-force toujours actif (429 après LOGIN_MAX_ATTEMPTS échecs, même avec le bon mot de passe)', async () => {
  const { app } = makeApp({ env: { LOGIN_MAX_ATTEMPTS: '3' } });
  const post = (password) => app.inject({ method: 'POST', url: '/api/auth/login', headers: { origin: ORIGIN }, payload: { password } });
  for (let i = 0; i < 3; i++) assert.equal((await post('faux')).statusCode, 401);
  const locked = await post(TEST_PASSWORD);
  assert.equal(locked.statusCode, 429); assert.equal(locked.json().error, 'too_many_attempts'); noTrace(locked.body);
});

test('Redéploiement et rechargement : session + confirmed:true suffisent (aucun code) ; 400 / 401 / 403 sinon', async () => {
  const fetch = dokployFixture();
  const client = new DokployClient({ url: 'https://dokploy.example.test', apiKey: 'FAKE_DOKPLOY_KEY' }, { fetch, sleep: async () => {} });
  const { app } = makeApp({ dokploy: client });
  const RELOAD = '/api/infrastructure/services/application/a/reload';
  for (const url of [REDEPLOY, RELOAD]) {
    const anon = await app.inject({ method: 'POST', url, headers: { origin: ORIGIN }, payload: { confirmed: true } });
    assert.equal(anon.statusCode, 401); noTrace(anon.body);
  }
  const cookie = await login(app);
  for (const url of [REDEPLOY, RELOAD]) {
    const post = (payload, origin = ORIGIN) => app.inject({ method: 'POST', url, headers: { cookie, origin }, payload });
    const unconfirmed = await post({});
    assert.equal(unconfirmed.statusCode, 400); assert.equal(unconfirmed.json().error, 'confirmation_required'); noTrace(unconfirmed.body);
    assert.equal((await post({ confirmed: 'oui' })).statusCode, 400);
    assert.equal((await post({ confirmed: true }, 'https://attacker.test')).statusCode, 403);
  }
  assert.equal(fetch.calls.filter((c) => /application\.(redeploy|reload)/.test(c.url)).length, 0, 'aucune mutation sans confirmation / origine valide');
  const ok = await app.inject({ method: 'POST', url: REDEPLOY, headers: { cookie, origin: ORIGIN }, payload: { confirmed: true } });
  assert.equal(ok.statusCode, 202, ok.body); noTrace(ok.body);
  assert.equal(fetch.calls.filter((c) => /application\.redeploy/.test(c.url)).length, 1);
});

// ------------------------------------------------------------------ Correctifs audit (F1, F2) : valeurs FACTICES
test('F1 : l’API refuse de démarrer si DOKPLOY_URL est défini et DOKPLOY_ACTION_ALLOWLIST vide', () => {
  const dok = { DOKPLOY_URL: 'https://dokploy.example.test', DOKPLOY_API_KEY: 'FAKE_DOKPLOY_KEY' };
  assert.throws(() => assertSecrets(testConfig(dok)), (e) => e instanceof ConfigError && /DOKPLOY_ACTION_ALLOWLIST/.test(e.message) && !e.message.includes('FAKE_DOKPLOY_KEY'));
  assert.throws(() => assertSecrets(testConfig({ ...dok, DOKPLOY_ACTION_ALLOWLIST: ' , ' })), /DOKPLOY_ACTION_ALLOWLIST/, 'liste ne contenant que des séparateurs = vide');
  assert.doesNotThrow(() => assertSecrets(testConfig({ ...dok, DOKPLOY_ACTION_ALLOWLIST: 'Alpha' })));
  assert.doesNotThrow(() => assertSecrets(testConfig({})), 'sans Dokploy : aucune exigence');
});

test('F1 : redéploiement / rechargement hors liste blanche -> HTTP 403, aucune mutation', async () => {
  const fetch = dokployFixture();
  const client = new DokployClient({ url: 'https://dokploy.example.test', apiKey: 'FAKE_DOKPLOY_KEY', actionAllowlist: ['Beta'] }, { fetch, sleep: async () => {} });
  const { app } = makeApp({ dokploy: client });
  const cookie = await login(app);
  for (const url of [REDEPLOY, '/api/infrastructure/services/application/a/reload']) {
    const r = await app.inject({ method: 'POST', url, headers: { cookie, origin: ORIGIN }, payload: { confirmed: true } });
    assert.equal(r.statusCode, 403, r.body); assert.equal(r.json().error, 'service_not_allowed');
  }
  assert.equal(fetch.calls.filter((c) => /application\.(redeploy|reload)/.test(c.url)).length, 0);
});

test('F2 : 50 échecs depuis des IP variées n’empêchent pas le bon mot de passe depuis une IP propre (200)', async () => {
  const { app } = makeApp();
  const post = (xff, password, cookie) => app.inject({ method: 'POST', url: '/api/auth/login', remoteAddress: '172.18.0.5', headers: { origin: ORIGIN, 'x-forwarded-for': xff, ...(cookie ? { cookie } : {}) }, payload: { password } });
  for (let i = 0; i < 50; i++) assert.equal((await post(`198.51.100.${i + 1}`, 'faux')).statusCode, 401);
  assert.equal((await post('203.0.113.7', TEST_PASSWORD)).statusCode, 200, 'administrateur non verrouillé');
});

test('F2 : seuil global configurable ; appareil connu (cookie signé) exempté ; IP au-delà de son quota non comptée', async () => {
  const { app } = makeApp({ env: { LOGIN_GLOBAL_MAX: '50', LOGIN_MAX_ATTEMPTS: '5' } });
  const post = (xff, password, cookie) => app.inject({ method: 'POST', url: '/api/auth/login', remoteAddress: '172.18.0.5', headers: { origin: ORIGIN, 'x-forwarded-for': xff, ...(cookie ? { cookie } : {}) }, payload: { password } });
  const first = await post('203.0.113.1', TEST_PASSWORD);
  assert.equal(first.statusCode, 200);
  const device = [].concat(first.headers['set-cookie']).find((c) => c.startsWith('sd_device='));
  assert.ok(device && /HttpOnly/.test(device) && /Secure/.test(device), 'cookie d’appareil HttpOnly + Secure');
  const deviceCookie = device.split(';')[0];
  for (let i = 0; i < 50; i++) await post(`198.51.100.${i + 1}`, 'faux');
  assert.equal((await post('203.0.113.9', TEST_PASSWORD)).statusCode, 429, 'appareil inconnu bloqué au seuil global');
  assert.equal((await post('203.0.113.9', TEST_PASSWORD, deviceCookie)).statusCode, 200, 'appareil connu exempté');
  assert.equal((await post('203.0.113.9', TEST_PASSWORD, 'sd_device=forge.abc')).statusCode, 429, 'cookie forgé refusé');
});
