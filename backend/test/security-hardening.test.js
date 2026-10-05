// Durcissement (audit 10/2026) : sessions révocables, second facteur TOTP, CSRF strict, proxy de confiance,
// avertissements de configuration, liste blanche Dokploy, journaux désactivables. Valeurs FACTICES uniquement.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeApp, login, testConfig, totpClock, TEST_PASSWORD, TEST_SECRET, TEST_TOTP_SECRET, fakeFetch } from './helpers.js';
import { base32Decode, base32Encode, hotp, totpAt, TotpVerifier, generateTotpSecret, normalizeBase32 } from '../src/totp.js';
import { SessionRegistry, createSession } from '../src/security.js';
import { assertSecrets, securityWarnings, ConfigError } from '../src/config.js';
import { DokployClient, DokployError } from '../src/dokploy.js';

const ORIGIN = 'https://dash.example.test';
const REDEPLOY = '/api/infrastructure/services/application/a/redeploy';

// ------------------------------------------------------------------ TOTP
test('TOTP : vecteurs RFC 6238 (SHA-1) et base32 aller-retour', () => {
  const secret = base32Encode(Buffer.from('12345678901234567890'));
  assert.equal(secret, 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
  assert.equal(totpAt(secret, 59_000), '287082');
  assert.equal(totpAt(secret, 1_111_111_109_000), '081804');
  assert.equal(totpAt(secret, 1_234_567_890_000), '005924');
  assert.equal(hotp(Buffer.from('12345678901234567890'), 0), '755224'); // RFC 4226
  assert.deepEqual(base32Decode(base32Encode(Buffer.from('abc'))), Buffer.from('abc'));
  assert.equal(normalizeBase32('jbsw y3dp-ehpk 3pxp=='), 'JBSWY3DPEHPK3PXP');
  assert.equal(normalizeBase32('pas du base32 !'), '');
  assert.equal(generateTotpSecret().length, 32);
});

test('TOTP : fenêtre ±1 pas, code invalide refusé, rejeu refusé', () => {
  let t = 1_700_000_000_000;
  const v = new TotpVerifier({ secret: TEST_TOTP_SECRET, now: () => t });
  assert.equal(v.verify('12345'), 'invalid');
  assert.equal(v.verify('abcdef'), 'invalid');
  assert.equal(v.verify(totpAt(TEST_TOTP_SECRET, t - 30_000)), 'ok', 'pas précédent toléré');
  assert.equal(v.verify(totpAt(TEST_TOTP_SECRET, t)), 'ok');
  assert.equal(v.verify(totpAt(TEST_TOTP_SECRET, t)), 'replay', 'même code rejoué');
  assert.equal(v.verify(totpAt(TEST_TOTP_SECRET, t - 30_000)), 'replay', 'code antérieur refusé');
  assert.equal(v.verify(totpAt(TEST_TOTP_SECRET, t - 120_000)), 'invalid', 'hors fenêtre');
  t += 30_000;
  assert.equal(v.verify(totpAt(TEST_TOTP_SECRET, t)), 'ok');
  assert.equal(new TotpVerifier({}).verify('123456'), 'invalid', 'sans secret : toujours refusé');
});

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

// ------------------------------------------------------------------ Second facteur à la connexion
test('Connexion avec DASHBOARD_TOTP_SECRET : code requis, faux code refusé, rejeu refusé, bon code accepté', async () => {
  const clock = totpClock();
  const { app } = makeApp({ now: clock.now, env: { DASHBOARD_TOTP_SECRET: TEST_TOTP_SECRET } });
  const post = (payload) => app.inject({ method: 'POST', url: '/api/auth/login', headers: { origin: ORIGIN }, payload });
  assert.equal((await app.inject({ url: '/api/auth/session' })).json().secondFactor, true);
  assert.equal((await post({ password: TEST_PASSWORD })).json().error, 'second_factor_required', 'code manquant');
  assert.equal((await post({ password: TEST_PASSWORD, totp: '000000' })).json().error, 'second_factor_invalid');
  const code = clock.code();
  assert.equal((await post({ password: 'faux-mot-de-passe', totp: code })).statusCode, 401, 'bon code, mauvais mot de passe');
  const ok = await post({ password: TEST_PASSWORD, totp: code });
  assert.equal(ok.statusCode, 200);
  const replay = await post({ password: TEST_PASSWORD, totp: code });
  assert.equal(replay.statusCode, 401); assert.equal(replay.json().error, 'totp_replay');
  assert.equal((await post({ password: TEST_PASSWORD, totp: clock.code() })).statusCode, 200, 'code suivant accepté');
});

test('Connexion sans DASHBOARD_TOTP_SECRET : mot de passe seul (compatibilité), secondFactor=false', async () => {
  const { app } = makeApp();
  assert.equal((await app.inject({ url: '/api/auth/session' })).json().secondFactor, false);
  await login(app);
});

// ------------------------------------------------------------------ Second facteur sur les actions d'infrastructure
function dokployFixture() {
  const project = () => ({ projectId: 'p1', name: 'Alpha', environments: [{ environmentId: 'e1', name: 'production', applications: [{ applicationId: 'a', name: 'app', appName: 'app-a', applicationStatus: 'done' }], compose: [] }] });
  const fetch = fakeFetch([
    [/settings.getDokployVersion/, () => ({ json: 'v0.30.8' })],
    [/settings.getOpenApiDocument/, () => ({ status: 404, json: {} })],
    [/project.all/, () => ({ json: [project()] })],
    [/project.one/, () => ({ json: project() })],
    [/deployment.all/, () => ({ json: [] })],
    [/application.redeploy/, () => ({ body: '' })],
    [/user.getMetricsToken/, () => ({ json: { serverIp: '127.0.0.1', metricsConfig: { server: { port: 4500, token: '' } } } })]
  ]);
  return fetch;
}

test('Redéploiement : refusé sans second facteur configuré (fail-closed), sans aucun appel Dokploy', async () => {
  const fetch = dokployFixture();
  const client = new DokployClient({ url: 'https://dokploy.example.test', apiKey: 'FAKE_DOKPLOY_KEY' }, { fetch, sleep: async () => {} });
  const { app } = makeApp({ dokploy: client });
  const cookie = await login(app);
  const r = await app.inject({ method: 'POST', url: REDEPLOY, headers: { cookie, origin: ORIGIN }, payload: { confirmed: true, totp: '123456' } });
  assert.equal(r.statusCode, 403); assert.equal(r.json().error, 'second_factor_not_configured');
  assert.equal(fetch.calls.filter((c) => /redeploy/.test(c.url)).length, 0);
});

test('Redéploiement : code absent, faux, rejoué refusés ; 5 échecs -> 429 ; code frais accepté', async () => {
  const fetch = dokployFixture();
  const client = new DokployClient({ url: 'https://dokploy.example.test', apiKey: 'FAKE_DOKPLOY_KEY' }, { fetch, sleep: async () => {} });
  const clock = totpClock();
  const { app } = makeApp({ dokploy: client, now: clock.now, env: { DASHBOARD_TOTP_SECRET: TEST_TOTP_SECRET } });
  const loginCode = clock.code();
  const cookie = await login(app, ORIGIN, { totp: loginCode });
  const post = (payload) => app.inject({ method: 'POST', url: REDEPLOY, headers: { cookie, origin: ORIGIN }, payload });
  assert.equal((await post({ confirmed: true })).json().error, 'second_factor_required');
  assert.equal((await post({ confirmed: true, totp: loginCode })).json().error, 'totp_replay', 'code de connexion non réutilisable');
  const ok = await post({ confirmed: true, totp: clock.code() });
  assert.equal(ok.statusCode, 202, ok.body);
  assert.equal(fetch.calls.filter((c) => /application.redeploy/.test(c.url)).length, 1);
  for (let i = 0; i < 5; i++) assert.equal((await post({ confirmed: true, totp: '000000' })).statusCode, 401);
  const blocked = await post({ confirmed: true, totp: clock.code() });
  assert.equal(blocked.statusCode, 429, 'brute-force du code bloqué');
  assert.equal(fetch.calls.filter((c) => /application.redeploy/.test(c.url)).length, 1, 'aucun redéploiement supplémentaire');
});

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

// ------------------------------------------------------------------ Régression : « mot de passe correct refusé » après l'audit
test('Connexion : messages distincts mot de passe / code 2FA manquant / code faux / trop d’essais', async () => {
  const clock = totpClock();
  const { app } = makeApp({ now: clock.now, env: { DASHBOARD_TOTP_SECRET: TEST_TOTP_SECRET, LOGIN_MAX_ATTEMPTS: '3' } });
  const post = (payload) => app.inject({ method: 'POST', url: '/api/auth/login', headers: { origin: ORIGIN }, payload });
  const bad = await post({ password: 'faux-mot-de-passe', totp: clock.code() });
  assert.equal(bad.json().error, 'invalid_password'); assert.match(bad.json().message, /^Mot de passe incorrect/);
  const missing = await post({ password: TEST_PASSWORD });
  assert.equal(missing.json().error, 'second_factor_required'); assert.equal(missing.json().secondFactor, true);
  assert.match(missing.json().message, /2FA/);
  assert.equal((await post({ password: TEST_PASSWORD, totp: '000000' })).json().error, 'second_factor_invalid');
  assert.equal((await post({ password: 'faux', totp: '000000' })).statusCode, 401);
  const locked = await post({ password: TEST_PASSWORD, totp: clock.code() });
  assert.equal(locked.statusCode, 429); assert.equal(locked.json().error, 'too_many_attempts');
});

test('Connexion : un ancien formulaire (sans champ 2FA) n’épuise pas le quota ; code avec espace accepté', async () => {
  const clock = totpClock();
  const { app } = makeApp({ now: clock.now, env: { DASHBOARD_TOTP_SECRET: TEST_TOTP_SECRET, LOGIN_MAX_ATTEMPTS: '2' } });
  const post = (payload) => app.inject({ method: 'POST', url: '/api/auth/login', headers: { origin: ORIGIN }, payload });
  for (let i = 0; i < 5; i++) assert.equal((await post({ password: TEST_PASSWORD })).json().error, 'second_factor_required');
  const code = clock.code();
  const ok = await post({ password: TEST_PASSWORD, totp: `${code.slice(0, 3)} ${code.slice(3)}` });
  assert.equal(ok.statusCode, 200, 'pas de verrouillage, code « 123 456 » normalisé');
  assert.match(ok.headers['set-cookie'], /^sd_session=/);
});

test('Connexion sans TOTP : mot de passe correct accepté avec Origin, ou sans Origin via Sec-Fetch-Site / Referer de même origine', async () => {
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
  const cookie = ok.headers['set-cookie'].split(';')[0];
  assert.equal((await app.inject({ url: '/api/auth/session', headers: { cookie } })).json().authenticated, true, 'session enregistrée');
  assert.equal((await app.inject({ url: '/api/status', headers: { cookie } })).statusCode, 200);
});

test('Front : page de connexion à jour (cache-bust incrémenté, champ 2FA affiché sur réponse serveur)', async () => {
  const fs = await import('node:fs');
  const html = fs.readFileSync(new URL('../../login.html', import.meta.url), 'utf8');
  const js = fs.readFileSync(new URL('../../js/login.js', import.meta.url), 'utf8');
  assert.match(html, /js\/login\.js\?v=(\d+)/);
  assert.ok(Number(html.match(/js\/login\.js\?v=(\d+)/)[1]) >= 16, 'ancienne version (servie avec un cache de 30 jours) contournée');
  assert.match(html, /id="totp"/);
  assert.match(js, /d\.secondFactor && !secondFactor/);
  assert.match(js, /second_factor_required/);
});

test('API : X-Robots-Tag noindex sur toutes les réponses', async () => {
  const { app } = makeApp();
  assert.equal((await app.inject({ url: '/api/health' })).headers['x-robots-tag'], 'noindex, nofollow');
});

// ------------------------------------------------------------------ Configuration
test('Configuration : TOTP mal formé et mot de passe identique à un secret refusés ; avertissements sans valeur secrète', () => {
  assert.throws(() => assertSecrets(testConfig({ DASHBOARD_TOTP_SECRET: 'court' })), (e) => e instanceof ConfigError && /DASHBOARD_TOTP_SECRET/.test(e.message) && !e.message.includes('court'));
  assert.throws(() => assertSecrets(testConfig({ DASHBOARD_TOTP_SECRET: '0189!!!!0189!!!!0189' })), ConfigError);
  assert.throws(() => assertSecrets(testConfig({ DASHBOARD_PASSWORD: TEST_SECRET })), /différent/);
  assert.doesNotThrow(() => assertSecrets(testConfig({ DASHBOARD_TOTP_SECRET: TEST_TOTP_SECRET })));
  const w = securityWarnings(testConfig({ DASHBOARD_PASSWORD: 'motdepasseweak', DOKPLOY_URL: 'https://dokploy.example.test' }));
  assert.ok(w.some((m) => /DASHBOARD_TOTP_SECRET/.test(m)));
  assert.ok(w.some((m) => /phrase de passe/.test(m)));
  assert.ok(w.some((m) => /DOKPLOY_ACTION_ALLOWLIST/.test(m)));
  assert.ok(!w.join(' ').includes('motdepasseweak'), 'aucune valeur secrète');
  assert.deepEqual(securityWarnings(testConfig({ DASHBOARD_TOTP_SECRET: TEST_TOTP_SECRET, DASHBOARD_PASSWORD: 'Une-Longue-Phrase-De-Passe-Unique-42' })), []);
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
