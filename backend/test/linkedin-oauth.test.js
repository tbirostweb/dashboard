import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Writable } from 'node:stream';
import { makeApp, login } from './helpers.js';
import { platformRoutes, LI_ACCESS } from './fixtures.js';

const ORIGIN = 'https://dashboard.birostweb.fr';
const LI_SECRET = 'LiClientSecretFACTICE-7f3a9c'; // valeur factice de test

test('LinkedIn de bout en bout : redirect URI, state, scopes, Page 146243022, aucun secret exposé (réponses, cookies, logs, disque)', async () => {
  const logs = [];
  const logStream = new Writable({ write(chunk, _enc, cb) { logs.push(chunk.toString()); cb(); } });
  const env = {
    PUBLIC_URL: ORIGIN,
    LINKEDIN_CLIENT_ID: 'li-client-id-factice',
    LINKEDIN_CLIENT_SECRET: LI_SECRET,
    LINKEDIN_ORGANIZATION_ID: '146243022',
    LINKEDIN_COMMUNITY_API: 'true'
  };
  const fetch = platformRoutes();
  const { app, store, cfg } = makeApp({ env, fetch, logStream });
  assert.equal(cfg.linkedin.redirectUri, 'https://dashboard.birostweb.fr/api/auth/linkedin/callback');

  const exposed = [];
  const keep = (res) => { exposed.push(res.body, JSON.stringify(res.headers)); return res; };
  const cookie = await login(app, ORIGIN);

  const go = keep(await app.inject({ url: '/api/auth/linkedin/login', headers: { cookie } }));
  assert.equal(go.statusCode, 302);
  const loc = new URL(go.headers.location);
  assert.equal(loc.origin + loc.pathname, 'https://www.linkedin.com/oauth/v2/authorization');
  assert.equal(loc.searchParams.get('redirect_uri'), 'https://dashboard.birostweb.fr/api/auth/linkedin/callback');
  assert.equal(loc.searchParams.get('client_id'), 'li-client-id-factice');
  assert.equal(loc.searchParams.get('response_type'), 'code');
  assert.deepEqual(loc.searchParams.get('scope').split(' '), ['r_organization_social', 'rw_organization_admin']);
  const state = loc.searchParams.get('state');
  const oc = String(go.headers['set-cookie']).split(';')[0];
  assert.match(String(go.headers['set-cookie']), /Path=\/api\/auth\/; SameSite=Lax; HttpOnly; Secure/);

  // Callback sans state valide → refusé, aucun échange de code
  const bad = keep(await app.inject({ url: '/api/auth/linkedin/callback?code=good-code&state=nope', headers: { cookie: oc } }));
  assert.match(bad.headers.location, /oauth_error=linkedin&reason=invalid_state/);
  assert.ok(!fetch.calls.some((c) => c.url.includes('/oauth/v2/accessToken')));

  const cb = keep(await app.inject({ url: `/api/auth/linkedin/callback?code=good-code&state=${state}`, headers: { cookie: oc } }));
  assert.equal(cb.headers.location, 'https://dashboard.birostweb.fr/?connected=linkedin#/linkedin');
  // Le secret part UNIQUEMENT vers l'endpoint token de LinkedIn, côté serveur
  const tokenCall = fetch.calls.find((c) => c.url.includes('/oauth/v2/accessToken'));
  const form = new URLSearchParams(tokenCall.init.body);
  assert.equal(form.get('client_secret'), LI_SECRET);
  assert.equal(form.get('redirect_uri'), 'https://dashboard.birostweb.fr/api/auth/linkedin/callback');
  fetch.calls.filter((c) => c !== tokenCall && !c.url.includes('/oauth/v2/')).forEach((c) => assert.ok(!JSON.stringify(c).includes(LI_SECRET)));

  let statsRes;
  for (const url of ['/api/status', '/api/overview?period=30', '/api/platforms/linkedin/stats?period=30', '/api/posts?platform=linkedin', '/api/comments?platform=linkedin', '/api/accounts']) {
    const r = keep(await app.inject({ url, headers: { cookie } }));
    assert.equal(r.statusCode, 200, url);
    if (url.includes('/stats')) statsRes = r;
  }
  const stats = statsRes.json();
  assert.equal(stats.account.name, 'Studio Test SAS');
  assert.equal(stats.kpis.followers.value, 777);

  keep(await app.inject({ method: 'POST', url: '/api/auth/linkedin/disconnect', headers: { cookie, origin: ORIGIN } }));
  assert.equal(await store.getToken('linkedin'), null);
  assert.deepEqual(await store.getSnapshots('linkedin'), {}, 'historique supprimé à la déconnexion');
  assert.ok(fetch.calls.some((c) => c.url.includes('/oauth/v2/revoke')));

  const all = exposed.join('\n') + logs.join('\n');
  assert.ok(logs.length > 0, 'des logs ont bien été produits');
  for (const secret of [LI_SECRET, LI_ACCESS, 'rft.']) {
    assert.ok(!all.includes(secret), `fuite détectée : ${secret.slice(0, 6)}…`);
  }
  // Le state voyage normalement dans l'URL d'autorisation, mais ni lui ni le code OAuth ne doivent être journalisés
  const logText = logs.join('\n');
  for (const v of ['good-code', state, 'code=']) assert.ok(!logText.includes(v), `journalisé : ${v.slice(0, 6)}…`);
  // Sur disque : fichier chiffré, ni secret ni token en clair
  const raw = fs.readFileSync(path.join(cfg.dataDir, 'store.enc.json'), 'utf8');
  assert.ok(!raw.includes(LI_ACCESS) && !raw.includes(LI_SECRET));
});
