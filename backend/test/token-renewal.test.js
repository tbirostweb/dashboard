// Renouvellement des jetons (hors réseau) : route manuelle, santé exposée par /api/status, backoff automatique, aucun secret.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Writable } from 'node:stream';
import { makeApp, login, fakeFetch, stubProvider, TEST_KEY } from './helpers.js';
import { decrypt } from '../src/crypto.js';
import { tokenStatus, retryDelayMs, frDate } from '../src/tokens.js';
import { DAY, CANARY } from './integration-fixtures.js';

const T0 = Date.parse('2026-10-01T10:00:00Z');
const HOUR = 3_600_000;
const ORIGIN = 'https://dash.example.test';
const NEW_ACCESS = 'act.NEW-ACCESS-0001';
const NEW_REFRESH = 'rft.NEW-REFRESH-0002';
const LEAK = 'LEAK-UPSTREAM-BODY-SECRET-9f8e7d6c5b4a39281706';

const tiktokOk = () => ([/open\.tiktokapis\.com\/v2\/oauth\/token/, () => ({ json: { access_token: NEW_ACCESS, refresh_token: NEW_REFRESH, expires_in: 86400, refresh_expires_in: 31_536_000, open_id: 'open-1', scope: 'user.info.basic' } })]);
const igOk = () => ([/refresh_access_token/, () => ({ json: { access_token: 'IGNEW-ACCESS-0003', expires_in: 5_184_000 } })]);
const readStore = (ctx) => JSON.parse(decrypt(JSON.parse(fs.readFileSync(path.join(ctx.cfg.dataDir, 'store.enc.json'), 'utf8')), TEST_KEY));

function logCapture() {
  const lines = [];
  const stream = new Writable({ write(chunk, _e, cb) { lines.push(String(chunk)); cb(); } });
  return { lines, stream };
}

async function setup({ routes = [], clock, tokens = {}, env = {}, providers, logStream } = {}) {
  const now = clock || (() => T0);
  const fetch = fakeFetch(routes);
  const ctx = makeApp({ fetch, now, env: { TIKTOK_RETRY_DELAY_MS: '0', LINKEDIN_COMMUNITY_API: 'true', LINKEDIN_ORGANIZATION_ID: '1', ...env }, providers, logStream });
  for (const [p, tk] of Object.entries(tokens)) await ctx.store.setToken(p, tk);
  ctx.cookie = await login(ctx.app);
  ctx.post = (platform, headers = {}) => ctx.app.inject({ method: 'POST', url: `/api/platforms/${platform}/token/refresh`, headers: { cookie: ctx.cookie, origin: ORIGIN, ...headers }, payload: {} });
  ctx.status = async () => (await ctx.app.inject({ url: '/api/status', headers: { cookie: ctx.cookie } })).json().platforms;
  return ctx;
}

const ttToken = (extra = {}) => ({ accessToken: CANARY.access, refreshToken: CANARY.refresh, expiresAt: T0 + 7 * HOUR, refreshExpiresAt: T0 + 300 * DAY, userId: 'open-1', ...extra });
const igToken = (extra = {}) => ({ accessToken: CANARY.access, refreshToken: null, obtainedAt: T0 - 40 * DAY, expiresAt: T0 + 20 * DAY, userId: 'ig-1', ...extra });

// ---------------------------------------------------------------------------- Route manuelle : succès
test('token/refresh TikTok : renouvelle sans attendre le seuil, persiste l’objet complet, aucun secret en sortie', async () => {
  const log = logCapture();
  const ctx = await setup({ routes: [tiktokOk()], tokens: { tiktok: ttToken() }, logStream: log.stream });
  const r = await ctx.post('tiktok');
  assert.equal(r.statusCode, 200);
  const b = r.json();
  assert.deepEqual(Object.keys(b).sort(), ['expiresAt', 'message', 'ok', 'platform', 'refreshExpiresAt', 'renewed', 'renewedAt']);
  assert.equal(b.ok, true); assert.equal(b.renewed, true); assert.equal(b.platform, 'tiktok');
  assert.equal(b.expiresAt, new Date(T0 + 86_400_000).toISOString());
  assert.equal(b.refreshExpiresAt, new Date(T0 + 31_536_000 * 1000).toISOString());
  assert.equal(b.renewedAt, new Date(T0).toISOString());
  const saved = readStore(ctx);
  assert.equal(saved.tokens.tiktok.accessToken, NEW_ACCESS);
  assert.equal(saved.tokens.tiktok.refreshToken, NEW_REFRESH, 'refresh token roté et persisté');
  assert.equal(saved.tokens.tiktok.refreshExpiresAt, T0 + 31_536_000 * 1000);
  assert.equal(saved.tokens.tiktok.userId, 'open-1');
  assert.equal(saved.tokenMeta.tiktok.lastRenewedAt, new Date(T0).toISOString());
  const body = r.body + log.lines.join('');
  for (const secret of [CANARY.access, CANARY.refresh, NEW_ACCESS, NEW_REFRESH]) assert.ok(!body.includes(secret), `fuite : ${secret}`);
  assert.equal(ctx.fetch.calls.length, 1);
  const st = (await ctx.status()).tiktok;
  assert.equal(st.token.lastRenewedAt, new Date(T0).toISOString());
  assert.equal(st.token.health, 'ok');
  assert.ok(!JSON.stringify(st).includes(NEW_REFRESH));
});

test('token/refresh Instagram : jeton long renouvelé et persisté', async () => {
  const ctx = await setup({ routes: [igOk()], tokens: { instagram: igToken() } });
  const r = await ctx.post('instagram');
  assert.equal(r.statusCode, 200);
  assert.equal(r.json().expiresAt, new Date(T0 + 5_184_000_000).toISOString());
  assert.equal(r.json().refreshExpiresAt, null);
  const saved = readStore(ctx).tokens.instagram;
  assert.equal(saved.accessToken, 'IGNEW-ACCESS-0003');
  assert.equal(saved.obtainedAt, T0);
  assert.ok(!r.body.includes('IGNEW-ACCESS'));
});

test('token/refresh : un succès invalide l’erreur d’authentification en cache', async () => {
  const ctx = await setup({ routes: [tiktokOk()], tokens: { tiktok: ttToken() } });
  ctx.cache.set('raw:tiktok:error', new Error('x'), 60_000);
  await ctx.post('tiktok');
  assert.equal(ctx.cache.get('raw:tiktok:error'), undefined);
});

// ---------------------------------------------------------------------------- Échecs classés
test('token/refresh Instagram trop tôt (< 24 h d’âge) : 409 too_soon avec eligibleAt/retryAfter, aucun appel', async () => {
  const ctx = await setup({ routes: [igOk()], tokens: { instagram: igToken({ obtainedAt: T0 - HOUR }) } });
  const r = await ctx.post('instagram');
  assert.equal(r.statusCode, 409);
  const b = r.json();
  assert.equal(b.error, 'too_soon');
  assert.equal(b.eligibleAt, new Date(T0 + 23 * HOUR).toISOString());
  assert.equal(b.retryAfter, 23 * 3600);
  assert.equal(ctx.fetch.calls.length, 0);
});

test('token/refresh Instagram : refus amont « 24 heures » => too_soon (pas reconnect_required) et aucune erreur mémorisée', async () => {
  const ctx = await setup({
    routes: [[/refresh_access_token/, () => ({ status: 400, json: { error: { message: 'Only tokens that are at least 24 hours old can be refreshed', code: 10 } } })]],
    tokens: { instagram: igToken({ obtainedAt: undefined }) }
  });
  const r = await ctx.post('instagram');
  assert.equal(r.statusCode, 409);
  assert.equal(r.json().error, 'too_soon');
  assert.equal((await ctx.status()).instagram.token.lastRenewError, null);
});

test('token/refresh TikTok invalid_grant (HTTP 400 ou 200) => 409 reconnect_required + reconnectPath', async () => {
  for (const status of [400, 200]) {
    const ctx = await setup({ routes: [[/oauth\/token/, () => ({ status, json: { error: 'invalid_grant', error_description: `Refresh token is invalid ${LEAK}` } })]], tokens: { tiktok: ttToken() } });
    const r = await ctx.post('tiktok');
    assert.equal(r.statusCode, 409, `statut ${status}`);
    const b = r.json();
    assert.equal(b.error, 'reconnect_required');
    assert.equal(b.reconnectPath, '/api/auth/tiktok/login');
    assert.ok(/reconnectez/i.test(b.message));
    assert.ok(!r.body.includes(LEAK) && !r.body.includes(CANARY.refresh));
    const st = (await ctx.status()).tiktok.token;
    assert.equal(st.health, 'reconnect_required');
    assert.equal(st.reconnectPath, '/api/auth/tiktok/login');
    assert.ok(st.lastRenewError && !st.lastRenewError.includes(LEAK));
  }
});

test('token/refresh TikTok : refresh token expiré => reconnect_required sans appel réseau', async () => {
  const ctx = await setup({ routes: [tiktokOk()], tokens: { tiktok: ttToken({ refreshExpiresAt: T0 - 1000 }) } });
  const r = await ctx.post('tiktok');
  assert.equal(r.statusCode, 409);
  assert.equal(r.json().error, 'reconnect_required');
  assert.equal(ctx.fetch.calls.length, 0);
});

test('token/refresh : 5xx / réseau => 502 upstream sans fuite ; le compte n’est PAS à reconnecter', async () => {
  const log = logCapture();
  const ctx = await setup({ routes: [[/oauth\/token/, () => ({ status: 503, json: { error: 'server_error', error_description: `down ${LEAK}`, refresh_token: CANARY.refresh } })]], tokens: { tiktok: ttToken() }, logStream: log.stream });
  const r = await ctx.post('tiktok');
  assert.equal(r.statusCode, 502);
  assert.equal(r.json().error, 'upstream');
  assert.ok(!r.body.includes(LEAK) && !r.body.includes(CANARY.refresh) && !r.body.includes('reconnectPath'));
  assert.ok(!log.lines.join('').includes(LEAK));
  const st = (await ctx.status()).tiktok.token;
  assert.equal(st.health, 'ok', 'échec transitoire : aucune demande de reconnexion');
  assert.ok(st.lastRenewError);
  assert.equal(st.reconnectPath, null);
  const net = await setup({ routes: [[/oauth\/token/, () => { throw new Error(`boom ${LEAK}`); }]], tokens: { tiktok: ttToken() } });
  const r2 = await net.post('tiktok');
  assert.equal(r2.statusCode, 502);
  assert.ok(!r2.body.includes(LEAK));
});

test('token/refresh : LinkedIn en attente d’approbation => 409 pending_approval, aucun appel', async () => {
  const ctx = await setup({ env: { LINKEDIN_COMMUNITY_API: 'false' }, tokens: { linkedin: { accessToken: CANARY.access, refreshToken: CANARY.refresh, expiresAt: T0 + 10 * DAY } } });
  const r = await ctx.post('linkedin');
  assert.equal(r.statusCode, 409);
  assert.equal(r.json().error, 'pending_approval');
  assert.equal(ctx.fetch.calls.length, 0);
  assert.equal((await ctx.status()).linkedin.token.health, 'pending');
});

test('token/refresh : LinkedIn sans refresh token => 409 not_refreshable + reconnectPath ; refresh() null idem', async () => {
  const ctx = await setup({ tokens: { linkedin: { accessToken: CANARY.access, expiresAt: T0 + 40 * DAY } } });
  const r = await ctx.post('linkedin');
  assert.equal(r.statusCode, 409);
  assert.equal(r.json().error, 'not_refreshable');
  assert.equal(r.json().reconnectPath, '/api/auth/linkedin/login');
  assert.equal(r.json().message, 'Ce réseau ne permet pas le renouvellement automatique : reconnectez le compte.');
  const stub = stubProvider('tiktok', () => ({}), { needsRefresh: () => false });
  const c2 = await setup({ providers: { tiktok: stub }, tokens: { tiktok: ttToken() } });
  const r2 = await c2.post('tiktok');
  assert.equal(r2.statusCode, 409);
  assert.equal(r2.json().error, 'not_refreshable');
  assert.equal(stub.calls.refresh, 1);
});

test('token/refresh : non connecté => 409 not_connected', async () => {
  const ctx = await setup();
  const r = await ctx.post('tiktok');
  assert.equal(r.statusCode, 409);
  assert.equal(r.json().error, 'not_connected');
});

// ---------------------------------------------------------------------------- Sécurité et limites
test('token/refresh : 401 sans session, 403 origine étrangère / cross-site, 404 plateforme inconnue', async () => {
  const ctx = await setup({ routes: [tiktokOk()], tokens: { tiktok: ttToken() } });
  const noSession = await ctx.app.inject({ method: 'POST', url: '/api/platforms/tiktok/token/refresh', headers: { origin: ORIGIN }, payload: {} });
  assert.equal(noSession.statusCode, 401);
  assert.equal((await ctx.post('tiktok', { origin: 'https://evil.example.com' })).statusCode, 403);
  assert.equal((await ctx.post('tiktok', { 'sec-fetch-site': 'cross-site' })).statusCode, 403);
  const unknown = await ctx.post('facebook');
  assert.equal(unknown.statusCode, 404);
  assert.equal(unknown.json().error, 'unknown_platform');
  assert.equal(ctx.fetch.calls.length, 0, 'aucun appel fournisseur pour une requête refusée');
});

test('token/refresh : 30 s minimum entre deux renouvellements manuels par plateforme (429 refresh_too_soon)', async () => {
  let t = T0;
  const ctx = await setup({ routes: [tiktokOk(), igOk()], clock: () => t, tokens: { tiktok: ttToken(), instagram: igToken() } });
  assert.equal((await ctx.post('tiktok')).statusCode, 200);
  t += 10_000;
  const early = await ctx.post('tiktok');
  assert.equal(early.statusCode, 429);
  assert.equal(early.json().error, 'refresh_too_soon');
  assert.equal(early.json().retryAfter, 20);
  assert.equal(early.headers['retry-after'], '20');
  assert.equal((await ctx.post('instagram')).statusCode, 200, 'autre plateforme : indépendante');
  t += 21_000;
  assert.equal((await ctx.post('tiktok')).statusCode, 200);
  assert.equal(ctx.fetch.calls.length, 3);
});

test('token/refresh : 6 requêtes par minute et par session (429 too_many_requests), fenêtre qui se libère', async () => {
  let t = T0;
  const ctx = await setup({ clock: () => t });
  for (let i = 0; i < 6; i++) assert.equal((await ctx.post('tiktok')).statusCode, 409);
  const r = await ctx.post('tiktok');
  assert.equal(r.statusCode, 429);
  assert.equal(r.json().error, 'too_many_requests');
  t += 61_000;
  assert.equal((await ctx.post('tiktok')).statusCode, 409);
});

// ---------------------------------------------------------------------------- Calcul de health (bornes)
const H = (platform, token, meta = null, extra = {}) => tokenStatus({ platform, token, meta, now: T0, ...extra });
const FAIL = { lastRenewError: { message: 'x', at: 'y', permanent: false } };
const PERM = { lastRenewError: { message: 'x', at: 'y', permanent: true } };

test('health TikTok : le jeton d’accès (< 1 h) n’est pas une échéance ; seul le refresh token compte (29 / 31 jours)', () => {
  const base = { accessToken: 'a', refreshToken: 'r', expiresAt: T0 + 30 * 60_000 };
  const ok = H('tiktok', { ...base, refreshExpiresAt: T0 + 31 * DAY });
  assert.equal(ok.health, 'ok'); assert.equal(ok.kind, 'auto'); assert.equal(ok.autoRenew, true);
  assert.equal(ok.reconnectPath, null);
  assert.equal(ok.note, `Renouvelé automatiquement ; reconnexion nécessaire avant le ${frDate(T0 + 31 * DAY)}`);
  assert.equal(H('tiktok', { ...base, expiresAt: T0 - HOUR, refreshExpiresAt: T0 + 300 * DAY }).health, 'ok', 'accès expiré mais renouvelable');
  const soon = H('tiktok', { ...base, refreshExpiresAt: T0 + 29 * DAY });
  assert.equal(soon.health, 'reconnect_soon');
  assert.equal(soon.reconnectBy, new Date(T0 + 29 * DAY).toISOString());
  assert.equal(soon.reconnectPath, '/api/auth/tiktok/login');
  assert.equal(H('tiktok', { ...base, refreshExpiresAt: T0 - 1 }).health, 'reconnect_required');
  assert.equal(H('tiktok', { ...base, refreshExpiresAt: T0 + 300 * DAY }, PERM).health, 'reconnect_required', 'refus définitif');
  assert.equal(H('tiktok', { ...base, refreshExpiresAt: T0 + 300 * DAY }, FAIL).health, 'ok', 'échec transitoire : pas de reconnexion');
  assert.equal(H('tiktok', { ...base, expiresAt: T0 - 1, refreshExpiresAt: T0 + 300 * DAY }, FAIL).health, 'renewing');
});

test('health Instagram : 7,1 / 6,9 jours avec ou sans échec de renouvellement, expiré, refus définitif', () => {
  const tk = (days) => ({ accessToken: 'a', expiresAt: T0 + days * DAY, obtainedAt: T0 - 50 * DAY });
  assert.equal(H('instagram', tk(7.1)).health, 'ok');
  assert.equal(H('instagram', tk(7.1), FAIL).health, 'ok');
  assert.equal(H('instagram', tk(6.9)).health, 'renewing');
  const soon = H('instagram', tk(6.9), FAIL);
  assert.equal(soon.health, 'reconnect_soon');
  assert.equal(soon.reconnectBy, new Date(T0 + 6.9 * DAY).toISOString());
  assert.equal(H('instagram', tk(-0.01)).health, 'reconnect_required');
  assert.equal(H('instagram', tk(30), PERM).health, 'reconnect_required');
  assert.equal(H('instagram', tk(30)).autoRenew, true);
});

test('health LinkedIn : manuel (13,9 / 14,1 jours, expiré), pending, non connecté', () => {
  const tk = (days, extra = {}) => ({ accessToken: 'a', expiresAt: T0 + days * DAY, ...extra });
  const ok = H('linkedin', tk(14.1));
  assert.equal(ok.health, 'ok'); assert.equal(ok.kind, 'manual'); assert.equal(ok.autoRenew, false);
  assert.equal(H('linkedin', tk(13.9)).health, 'reconnect_soon');
  assert.equal(H('linkedin', tk(-1)).health, 'reconnect_required');
  assert.equal(H('linkedin', tk(30), null, { pending: true }).health, 'pending');
  assert.equal(H('linkedin', null).health, 'not_connected');
  const withRefresh = H('linkedin', tk(3, { refreshToken: 'r', refreshExpiresAt: T0 + 200 * DAY }));
  assert.equal(withRefresh.kind, 'auto'); assert.equal(withRefresh.health, 'ok');
});

test('retryDelayMs : plancher 15 min, doublement, plafond 6 h', () => {
  assert.equal(retryDelayMs(1, false), 15 * 60_000);
  assert.equal(retryDelayMs(2, false), 30 * 60_000);
  assert.equal(retryDelayMs(20, false), 6 * HOUR);
  assert.equal(retryDelayMs(1, true), 6 * HOUR);
});

test('/api/status : bloc token complet, rétrocompatibilité des champs existants, aucun jeton', async () => {
  const ctx = await setup({ tokens: { tiktok: ttToken(), instagram: igToken() } });
  const p = await ctx.status();
  const tt = p.tiktok;
  for (const k of ['expiresAt', 'refreshExpiresAt', 'refreshable', 'connected', 'status']) assert.ok(k in tt, k);
  assert.deepEqual(Object.keys(tt.token).sort(), ['accessExpiresAt', 'autoRenew', 'health', 'kind', 'lastRenewError', 'lastRenewedAt', 'note', 'reconnectBy', 'reconnectPath', 'refreshExpiresAt']);
  assert.equal(tt.token.accessExpiresAt, tt.expiresAt);
  assert.equal(p.linkedin.token.health, 'not_connected');
  assert.ok(!JSON.stringify(p).includes(CANARY.access) && !JSON.stringify(p).includes(CANARY.refresh));
});

// ---------------------------------------------------------------------------- Renouvellement automatique : backoff, persistance
function flaky(extra = {}) {
  const st = { fail: true, calls: 0, kind: 'transient' };
  const provider = stubProvider('tiktok', () => ({ account: { platform: 'tiktok', name: 't', handle: '@t', url: '' }, followers: 1, posts: [], comments: null, notes: [] }), {
    needsRefresh: (tk) => tk.expiresAt - Date.now() < 0 || tk.expiresAt < st.now + HOUR,
    refresh: async (tk) => {
      st.calls++;
      if (st.fail) throw Object.assign(new Error(`erreur ${LEAK}`), { name: 'ProviderError', code: 'upstream', status: 503 });
      return { ...tk, accessToken: 'new-access', expiresAt: st.now + 24 * HOUR };
    },
    ...extra
  });
  return { st, provider };
}

test('renouvellement automatique : échec mémorisé (générique, persisté sans jeton), backoff 15 min, succès efface l’erreur', async () => {
  const { ProviderError } = await import('../src/http.js');
  let t = T0;
  const { st, provider } = flaky();
  st.now = t;
  provider.refresh = async (tk) => {
    st.calls++;
    if (st.fail) throw new ProviderError('tiktok', 'upstream', `Erreur API 503 : ${LEAK}`, 503);
    return { ...tk, accessToken: 'new-access', expiresAt: t + 24 * HOUR };
  };
  provider.needsRefresh = (tk) => tk.expiresAt - t < HOUR;
  const ctx = await setup({ clock: () => t, providers: { tiktok: provider }, tokens: { tiktok: ttToken({ expiresAt: T0 + 30 * 60_000 }) } });

  await ctx.service.freshToken('tiktok');
  assert.equal(st.calls, 1);
  const meta = readStore(ctx).tokenMeta.tiktok;
  assert.equal(meta.failures, 1);
  assert.equal(meta.nextRetryAt, T0 + 15 * 60_000);
  assert.ok(meta.lastRenewError.message && !JSON.stringify(readStore(ctx).tokenMeta).includes(LEAK));
  assert.ok(!JSON.stringify(readStore(ctx).tokenMeta).includes(CANARY.access));
  assert.equal((await ctx.status()).tiktok.token.lastRenewError, meta.lastRenewError.message);

  // lectures répétées pendant le backoff : aucun nouvel appel (pas de boucle serrée)
  for (let i = 0; i < 5; i++) await ctx.service.freshToken('tiktok');
  await ctx.service.refreshAll({ mode: 'essential' });
  await ctx.service.refreshAll({ mode: 'full' });
  assert.equal(st.calls, 1);

  t += 15 * 60_000 + 1;
  await ctx.service.renewDueTokens(); // 2e échec : backoff doublé
  assert.equal(st.calls, 2);
  assert.equal(readStore(ctx).tokenMeta.tiktok.nextRetryAt, t + 30 * 60_000);

  t += 30 * 60_000 + 1;
  st.fail = false;
  await ctx.service.renewDueTokens();
  assert.equal(st.calls, 3);
  const after = readStore(ctx);
  assert.equal(after.tokens.tiktok.accessToken, 'new-access');
  assert.equal(after.tokenMeta.tiktok.lastRenewError, null);
  assert.equal(after.tokenMeta.tiktok.failures, 0);
  assert.equal(after.tokenMeta.tiktok.lastRenewedAt, new Date(t).toISOString());
  assert.equal((await ctx.status()).tiktok.token.lastRenewError, null);
});

test('renouvellement automatique : refreshAll essential et full renouvellent sans présence utilisateur', async () => {
  for (const mode of ['essential', 'full']) {
    let t = T0;
    const calls = { n: 0 };
    const provider = stubProvider('tiktok', () => ({ account: { platform: 'tiktok', name: 't', handle: '@t', url: '' }, followers: 5, posts: [], comments: null, notes: [] }), {
      needsRefresh: (tk) => tk.expiresAt - t < HOUR,
      refresh: async (tk) => { calls.n++; return { ...tk, accessToken: 'n', expiresAt: t + 24 * HOUR }; }
    });
    const ctx = await setup({ clock: () => t, providers: { tiktok: provider }, tokens: { tiktok: ttToken({ expiresAt: T0 + 20 * 60_000 }) } });
    assert.equal(ctx.presence.active(), false);
    await ctx.service.refreshAll({ mode });
    assert.equal(calls.n, 1, mode);
    assert.equal((await ctx.store.getToken('tiktok')).expiresAt, T0 + 24 * HOUR);
  }
});

test('renouvellement automatique : un refus définitif est mémorisé et espacé de 6 h (pas de boucle)', async () => {
  const { ProviderError } = await import('../src/http.js');
  let t = T0;
  const calls = { n: 0 };
  const provider = stubProvider('tiktok', () => ({}), {
    needsRefresh: () => true,
    refresh: async () => { calls.n++; throw new ProviderError('tiktok', 'upstream', 'Erreur API 400 : invalid_grant', 400); }
  });
  const ctx = await setup({ clock: () => t, providers: { tiktok: provider }, tokens: { tiktok: ttToken() } });
  await ctx.service.renewDueTokens();
  await ctx.service.renewDueTokens();
  assert.equal(calls.n, 1);
  const meta = readStore(ctx).tokenMeta.tiktok;
  assert.equal(meta.lastRenewError.permanent, true);
  assert.equal(meta.nextRetryAt, T0 + 6 * HOUR);
  assert.equal((await ctx.status()).tiktok.token.health, 'reconnect_required');
});

test('renouvellement automatique : aucun appel en pendingApproval', async () => {
  const calls = { n: 0 };
  const provider = stubProvider('linkedin', () => ({}), { pendingApproval: true, needsRefresh: () => true, refresh: async () => { calls.n++; return null; } });
  const ctx = await setup({ providers: { linkedin: provider }, tokens: { linkedin: { accessToken: CANARY.access, refreshToken: CANARY.refresh, expiresAt: T0 + HOUR } } });
  await ctx.service.refreshAll({ mode: 'essential' });
  await ctx.service.refreshAll({ mode: 'full' });
  await ctx.service.renewDueTokens();
  assert.equal(calls.n, 0);
  assert.equal(ctx.fetch.calls.length, 0);
});

test('renouvellement : appels concurrents mutualisés (un seul refresh, le refresh token tourne)', async () => {
  const calls = { n: 0 };
  const provider = stubProvider('tiktok', () => ({}), {
    needsRefresh: () => false,
    refresh: async (tk) => { calls.n++; await new Promise((r) => setTimeout(r, 5)); return { ...tk, accessToken: 'n', refreshToken: 'rotated' }; }
  });
  const ctx = await setup({ providers: { tiktok: provider }, tokens: { tiktok: ttToken() } });
  await Promise.all([ctx.service.renewToken('tiktok'), ctx.service.renewToken('tiktok', { manual: true })]);
  assert.equal(calls.n, 1);
});

test('nouvelle connexion / déconnexion : l’historique de renouvellement est effacé', async () => {
  const ctx = await setup({ tokens: { tiktok: ttToken() } });
  await ctx.service.recordRenewFailure('tiktok', 'transient');
  assert.ok(readStore(ctx).tokenMeta.tiktok);
  await ctx.app.inject({ method: 'POST', url: '/api/auth/tiktok/disconnect', headers: { cookie: ctx.cookie, origin: ORIGIN }, payload: {} });
  assert.equal(readStore(ctx).tokenMeta.tiktok, undefined);
});
