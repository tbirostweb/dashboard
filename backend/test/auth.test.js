import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeApp, login, TEST_PASSWORD } from './helpers.js';
import { platformRoutes, TT_ACCESS, IG_LONG, IG_SHORT } from './fixtures.js';

const ORIGIN = 'https://dash.example.test';

test('/api/health est public ; le reste de /api exige une session', async () => {
  const { app } = makeApp();
  assert.equal((await app.inject('/api/health')).statusCode, 200);
  for (const url of ['/api/status', '/api/overview?period=30', '/api/accounts', '/api/posts', '/api/comments', '/api/platforms/tiktok/stats', '/api/auth/tiktok/login']) {
    const r = await app.inject(url);
    assert.equal(r.statusCode, 401, url);
    assert.equal(r.json().error, 'unauthenticated');
  }
  assert.equal((await app.inject({ method: 'POST', url: '/api/auth/tiktok/disconnect', headers: { origin: ORIGIN } })).statusCode, 401);
});

test('Login : cookie httpOnly/Secure/SameSite, puis accès autorisé ; cookie altéré refusé', async () => {
  const { app } = makeApp();
  const bad = await app.inject({ method: 'POST', url: '/api/auth/login', headers: { origin: ORIGIN }, payload: { password: 'faux' } });
  assert.equal(bad.statusCode, 401);
  assert.equal(bad.headers['set-cookie'], undefined);

  const ok = await app.inject({ method: 'POST', url: '/api/auth/login', headers: { origin: ORIGIN }, payload: { password: TEST_PASSWORD } });
  assert.equal(ok.statusCode, 200);
  const sc = String(ok.headers['set-cookie']);
  assert.match(sc, /^sd_session=/);
  assert.match(sc, /HttpOnly/);
  assert.match(sc, /Secure/);
  assert.match(sc, /SameSite=Lax/);
  const cookie = sc.split(';')[0];

  const st = await app.inject({ url: '/api/status', headers: { cookie } });
  assert.equal(st.statusCode, 200);
  assert.equal(st.headers['cache-control'], 'no-store');
  assert.equal(st.headers['access-control-allow-origin'], undefined, 'CORS fermé');

  assert.equal((await app.inject({ url: '/api/status', headers: { cookie: cookie.slice(0, -2) + 'xx' } })).statusCode, 401);
  assert.equal((await app.inject({ url: '/api/auth/session', headers: { cookie } })).json().authenticated, true);

  const out = await app.inject({ method: 'POST', url: '/api/auth/logout', headers: { origin: ORIGIN, cookie } });
  assert.match(String(out.headers['set-cookie']), /Max-Age=0/);
});

test('Anti brute-force : 429 après 5 échecs, même avec le bon mot de passe', async () => {
  const { app } = makeApp();
  for (let i = 0; i < 5; i++) {
    const r = await app.inject({ method: 'POST', url: '/api/auth/login', headers: { origin: ORIGIN }, payload: { password: `faux-${i}` } });
    assert.equal(r.statusCode, 401);
  }
  const blocked = await app.inject({ method: 'POST', url: '/api/auth/login', headers: { origin: ORIGIN }, payload: { password: TEST_PASSWORD } });
  assert.equal(blocked.statusCode, 429);
  assert.ok(Number(blocked.headers['retry-after']) > 0);
});

test('Anti-CSRF : POST depuis une autre origine refusé ; OPTIONS (CORS) refusé', async () => {
  const { app } = makeApp();
  const r = await app.inject({ method: 'POST', url: '/api/auth/login', headers: { origin: 'https://evil.example' }, payload: { password: TEST_PASSWORD } });
  assert.equal(r.statusCode, 403);
  const r2 = await app.inject({ method: 'POST', url: '/api/auth/login', headers: { 'sec-fetch-site': 'cross-site' }, payload: { password: TEST_PASSWORD } });
  assert.equal(r2.statusCode, 403);
  const pre = await app.inject({ method: 'OPTIONS', url: '/api/status', headers: { origin: 'https://evil.example', 'access-control-request-method': 'GET' } });
  assert.notEqual(pre.statusCode, 200);
  assert.equal(pre.headers['access-control-allow-origin'], undefined);
});

test('OAuth TikTok : redirection avec state, callback, token chiffré, statut, déconnexion', async () => {
  const fetch = platformRoutes();
  const { app, store } = makeApp({ fetch });
  const cookie = await login(app);

  const go = await app.inject({ url: '/api/auth/tiktok/login', headers: { cookie } });
  assert.equal(go.statusCode, 302);
  const loc = new URL(go.headers.location);
  assert.equal(loc.origin + loc.pathname, 'https://www.tiktok.com/v2/auth/authorize/');
  assert.equal(loc.searchParams.get('redirect_uri'), 'https://dash.example.test/api/auth/tiktok/callback');
  assert.equal(loc.searchParams.get('client_key'), 'tt-client-key');
  assert.match(loc.searchParams.get('scope'), /video\.list/);
  const state = loc.searchParams.get('state');
  assert.ok(state && state.length >= 32);
  const oauthCookie = String(go.headers['set-cookie']).split(';')[0];
  assert.match(oauthCookie, /^sd_oauth=/);

  // state falsifié → refusé
  const forged = await app.inject({ url: `/api/auth/tiktok/callback?code=good-code&state=forged`, headers: { cookie: oauthCookie } });
  assert.equal(forged.statusCode, 302);
  assert.match(forged.headers.location, /oauth_error=tiktok&reason=invalid_state/);

  // bon state mais sans le cookie du navigateur → refusé (et le state est consommé)
  const go2 = await app.inject({ url: '/api/auth/tiktok/login', headers: { cookie } });
  const state2 = new URL(go2.headers.location).searchParams.get('state');
  const noCookie = await app.inject({ url: `/api/auth/tiktok/callback?code=good-code&state=${state2}` });
  assert.match(noCookie.headers.location, /reason=invalid_state/);

  // callback valide
  const cb = await app.inject({ url: `/api/auth/tiktok/callback?code=good-code&state=${state}`, headers: { cookie: oauthCookie } });
  assert.equal(cb.statusCode, 302);
  assert.equal(cb.headers.location, 'https://dash.example.test/?connected=tiktok#/tiktok');
  assert.equal((await store.getToken('tiktok')).accessToken, TT_ACCESS);

  // rejeu du même state → refusé
  const replay = await app.inject({ url: `/api/auth/tiktok/callback?code=good-code&state=${state}`, headers: { cookie: oauthCookie } });
  assert.match(replay.headers.location, /invalid_state/);

  const st = await app.inject({ url: '/api/status', headers: { cookie } });
  const body = st.body;
  assert.ok(!body.includes(TT_ACCESS) && !body.includes('rft.fake'), 'aucun token renvoyé au client');
  const tt = st.json().platforms.tiktok;
  assert.equal(tt.connected, true);
  assert.equal(tt.refreshable, true);
  assert.ok(Date.parse(tt.expiresAt) > Date.now());
  assert.equal(tt.commentsAvailable, false);

  const dis = await app.inject({ method: 'POST', url: '/api/auth/tiktok/disconnect', headers: { cookie, origin: ORIGIN } });
  assert.equal(dis.statusCode, 200);
  assert.equal(await store.getToken('tiktok'), null);
  assert.ok(fetch.calls.some((c) => c.url.includes('/v2/oauth/revoke/')));
});

test('OAuth : code refusé par la plateforme, accès refusé par l’utilisateur, plateforme non configurée', async () => {
  const { app, store } = makeApp({ fetch: platformRoutes(), env: { LINKEDIN_CLIENT_ID: '', LINKEDIN_COMMUNITY_API: 'true' } });
  const cookie = await login(app);

  const go = await app.inject({ url: '/api/auth/tiktok/login', headers: { cookie } });
  const state = new URL(go.headers.location).searchParams.get('state');
  const oc = String(go.headers['set-cookie']).split(';')[0];
  const r = await app.inject({ url: `/api/auth/tiktok/callback?code=bad-code&state=${state}`, headers: { cookie: oc } });
  assert.match(r.headers.location, /reason=token_exchange/);
  assert.equal(await store.getToken('tiktok'), null);

  const go2 = await app.inject({ url: '/api/auth/instagram/login', headers: { cookie } });
  const s2 = new URL(go2.headers.location).searchParams.get('state');
  const oc2 = String(go2.headers['set-cookie']).split(';')[0];
  const denied = await app.inject({ url: `/api/auth/instagram/callback?error=access_denied&state=${s2}`, headers: { cookie: oc2 } });
  assert.match(denied.headers.location, /oauth_error=instagram&reason=denied/);

  const nc = await app.inject({ url: '/api/auth/linkedin/login', headers: { cookie } });
  assert.match(nc.headers.location, /oauth_error=linkedin&reason=not_configured/);
  assert.equal((await app.inject({ url: '/api/auth/myspace/login', headers: { cookie } })).statusCode, 404);
});

test('OAuth Instagram : échange court → long-lived, puis refresh automatique proche de l’expiration', async () => {
  let t = Date.now();
  const fetch = platformRoutes(t);
  const { app, store, service } = makeApp({ fetch, now: () => t });
  const cookie = await login(app);
  const go = await app.inject({ url: '/api/auth/instagram/login', headers: { cookie } });
  const loc = new URL(go.headers.location);
  assert.equal(loc.origin + loc.pathname, 'https://www.instagram.com/oauth/authorize');
  assert.match(loc.searchParams.get('scope'), /instagram_business_basic/);
  const oc = String(go.headers['set-cookie']).split(';')[0];
  // Instagram ajoute "#_" au code : il doit être retiré
  await app.inject({ url: `/api/auth/instagram/callback?code=${encodeURIComponent('good-code#_')}&state=${loc.searchParams.get('state')}`, headers: { cookie: oc } });
  const tok = await store.getToken('instagram');
  assert.equal(tok.accessToken, IG_LONG);
  assert.notEqual(tok.accessToken, IG_SHORT);
  assert.ok(tok.expiresAt - t > 50 * 86_400_000);

  // 55 jours plus tard : à moins de 7 j de l'échéance → refresh
  t += 55 * 86_400_000;
  const fresh = await service.freshToken('instagram');
  assert.equal(fresh.accessToken, 'IGAArefreshed');
  assert.equal((await store.getToken('instagram')).accessToken, 'IGAArefreshed');
});
