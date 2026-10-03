import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Writable } from 'node:stream';
import { makeApp, login } from './helpers.js';
import { platformRoutes, LI_ACCESS } from './fixtures.js';

const ORIGIN = 'https://dashboard.birostweb.fr';
const SECRET = 'LiClientSecretFACTICE-pending-91';
const BASE = { PUBLIC_URL: ORIGIN, LINKEDIN_CLIENT_ID: 'li-id-factice', LINKEDIN_CLIENT_SECRET: SECRET, LINKEDIN_ORGANIZATION_ID: '146243022' };

test('En attente d’approbation (LINKEDIN_COMMUNITY_API=false) : aucun OAuth, aucune donnée LinkedIn, même avec MOCK_FALLBACK', async () => {
  const logs = [];
  const logStream = new Writable({ write(c, _e, cb) { logs.push(String(c)); cb(); } });
  const fetch = platformRoutes();
  const { app } = makeApp({ fetch, logStream, env: { ...BASE, MOCK_FALLBACK: 'true', LINKEDIN_COMMUNITY_API: 'false' } });
  const cookie = await login(app, ORIGIN);
  const bodies = [];
  const get = async (url) => { const r = await app.inject({ url, headers: { cookie } }); bodies.push(r.body, JSON.stringify(r.headers)); return r; };

  const st = (await get('/api/status')).json();
  assert.equal(st.platforms.linkedin.status, 'pending_approval');
  assert.ok(st.platforms.linkedin.pendingSteps.some((x) => x.includes('https://dashboard.birostweb.fr/api/auth/linkedin/callback')));
  assert.equal(st.platforms.instagram.status, 'not_connected', 'Aucune démo Instagram');

  const go = await get('/api/auth/linkedin/login');
  assert.equal(go.statusCode, 302);
  assert.equal(go.headers.location, 'https://dashboard.birostweb.fr/?oauth_error=linkedin&reason=pending_approval#/linkedin');

  const stats = await get('/api/platforms/linkedin/stats?period=30');
  assert.equal(stats.statusCode, 409);
  assert.equal(stats.json().error, 'pending_approval');
  assert.ok(stats.json().steps.length >= 3);
  assert.equal((await get('/api/posts?platform=linkedin')).statusCode, 409);

  const ov = (await get('/api/overview?period=90')).json();
  assert.equal(ov.sources.linkedin.status, 'pending_approval');
  assert.equal(ov.distribution.linkedin, null, 'aucune statistique fictive LinkedIn');
  assert.equal(ov.perPlatform.linkedin.followers.value, null);
  assert.equal(ov.perPlatform.instagram.followers.value, null, 'aucune démo Instagram');
  assert.ok(ov.topPosts.every((p) => p.platform !== 'linkedin'));
  const posts = (await get('/api/posts?period=90')).json();
  assert.deepEqual(posts, []);
  const cm = (await get('/api/comments?period=90')).json();
  assert.ok(cm.items.every((c) => c.platform !== 'linkedin'));
  assert.match(cm.unavailable.find((u) => u.platform === 'linkedin').reason, /attente d'approbation/);
  const acc = (await get('/api/accounts')).json().find((a) => a.platform === 'linkedin');
  assert.equal(acc.name, 'LinkedIn');

  const dbg = (await get('/api/debug/linkedin')).json();
  assert.equal(dbg.status, 'blocked');
  assert.equal(dbg.config.clientSecretSet, true);
  assert.deepEqual(dbg.config.scopes, ['r_organization_social', 'rw_organization_admin']);
  assert.match(dbg.firstFailure, /LINKEDIN_COMMUNITY_API=false/);

  assert.equal(fetch.calls.filter((c) => c.url.includes('linkedin.com')).length, 0, 'aucun appel à LinkedIn');
  const all = bodies.join('\n') + logs.join('\n');
  assert.ok(!all.includes(SECRET), 'secret jamais exposé');
});

test('Diagnostic LinkedIn : protégé par la session', async () => {
  const { app } = makeApp({ env: BASE });
  assert.equal((await app.inject('/api/debug/linkedin')).statusCode, 401);
});

test('Approuvé côté config mais 403 ACCESS_DENIED sur les endpoints organisation → pending_approval ; diagnostic précis', async () => {
  const now = Date.now();
  const denied = () => ({ status: 403, json: { status: 403, serviceErrorCode: 100, code: 'ACCESS_DENIED', message: 'Not enough permissions to access: organizations.GET.20260901' } });
  const fetch = platformRoutes(now, { routes: [
    [/api\.linkedin\.com\/rest\/organizations\//, denied],
    [/api\.linkedin\.com\/rest\/networkSizes\//, denied]
  ] });
  const { app, store } = makeApp({ fetch, now: () => now, env: { ...BASE, LINKEDIN_COMMUNITY_API: 'true', MOCK_FALLBACK: 'true' } });
  await store.setToken('linkedin', { accessToken: LI_ACCESS, expiresAt: now + 30 * 86_400_000, scope: 'r_organization_social,rw_organization_admin' });
  const cookie = await login(app, ORIGIN);

  const r = await app.inject({ url: '/api/platforms/linkedin/stats', headers: { cookie } });
  assert.equal(r.statusCode, 409);
  assert.equal(r.json().error, 'pending_approval');
  const ov = (await app.inject({ url: '/api/overview', headers: { cookie } })).json();
  assert.equal(ov.sources.linkedin.status, 'pending_approval');
  assert.equal(ov.perPlatform.linkedin.followers.value, null, 'pas de repli fictif');
  const st = (await app.inject({ url: '/api/status', headers: { cookie } })).json();
  assert.equal(st.platforms.linkedin.status, 'pending_approval');

  const dbg = await app.inject({ url: '/api/debug/linkedin', headers: { cookie } });
  const d = dbg.json();
  assert.equal(d.status, 'failed');
  assert.equal(d.token.present, true);
  assert.deepEqual(d.token.grantedScopes, ['r_organization_social', 'rw_organization_admin']);
  assert.equal(d.calls[0].ok, false);
  assert.equal(d.calls[0].httpStatus, 403);
  assert.match(d.firstFailure, /organizations\/\{id\} \(scope rw_organization_admin\) : 403/);
  assert.equal(d.calls.find((c) => c.step === 'posts?q=author').ok, true);
  assert.ok(!dbg.body.includes(LI_ACCESS), 'token jamais renvoyé');
});

test('Approuvé : le diagnostic isole précisément l’appel refusé (follower statistics en 403 dans la fixture)', async () => {
  const now = Date.now();
  const { app, store } = makeApp({ fetch: platformRoutes(now), now: () => now, env: { ...BASE, LINKEDIN_COMMUNITY_API: 'true' } });
  await store.setToken('linkedin', { accessToken: LI_ACCESS, expiresAt: now + 30 * 86_400_000, scope: 'r_organization_social,rw_organization_admin' });
  const cookie = await login(app, ORIGIN);
  const d = (await app.inject({ url: '/api/debug/linkedin', headers: { cookie } })).json();
  assert.equal(d.calls.length, 6);
  assert.match(d.calls[1].detail, /777 followers/);
  assert.deepEqual(d.calls.map((c) => c.ok), [true, true, true, true, false, true]);
  assert.equal(d.status, 'failed');
  assert.match(d.firstFailure, /^organizationalEntityFollowerStatistics \(7 j\) \(scope rw_organization_admin\) : 403/);
});
