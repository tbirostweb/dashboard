import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSession, verifySession, LoginLimiter, OAuthStates, parseCookies, serializeCookie } from '../src/security.js';
import { TtlCache } from '../src/cache.js';

const SECRET = 's'.repeat(64);

test('Session signée : valide, altérée, expirée, mauvais secret', () => {
  const t0 = 1_000_000;
  const v = createSession(SECRET, 60_000, t0);
  assert.ok(verifySession(v, SECRET, t0 + 1000));
  assert.equal(verifySession(v, SECRET, t0 + 60_001), null, 'expirée');
  assert.equal(verifySession(v, 'autre'.repeat(10), t0), null, 'mauvais secret');
  const [payload, sig] = v.split('.');
  const forged = Buffer.from(JSON.stringify({ sid: 'x', iat: t0, exp: t0 + 1e12 })).toString('base64url');
  assert.equal(verifySession(`${forged}.${sig}`, SECRET, t0), null, 'payload modifié');
  assert.equal(verifySession(`${payload}.${sig}x`, SECRET, t0), null);
  assert.equal(verifySession(undefined, SECRET, t0), null);
  assert.equal(verifySession('a.b.c', SECRET, t0), null);
});

test('Cookies : sérialisation et parsing', () => {
  const c = serializeCookie('sd_session', 'abc.def', { secure: true, maxAge: 60 });
  assert.match(c, /HttpOnly/);
  assert.match(c, /Secure/);
  assert.match(c, /SameSite=Lax/);
  assert.match(c, /Max-Age=60/);
  assert.deepEqual(parseCookies('a=1; sd_session=abc.def; b=x%20y'), { a: '1', sd_session: 'abc.def', b: 'x y' });
});

test('Anti brute-force : blocage après N échecs, par IP, puis déblocage', () => {
  let t = 0;
  const l = new LoginLimiter({ maxAttempts: 3, windowMs: 1000, globalMax: 100, now: () => t });
  for (let i = 0; i < 3; i++) { assert.equal(l.retryAfter('1.1.1.1'), 0); l.fail('1.1.1.1'); }
  assert.ok(l.retryAfter('1.1.1.1') > 0, 'IP bloquée');
  assert.equal(l.retryAfter('2.2.2.2'), 0, 'autre IP non bloquée');
  t = 1001;
  assert.equal(l.retryAfter('1.1.1.1'), 0, 'débloquée après la fenêtre');
});

test('Anti brute-force : limite globale (attaque distribuée)', () => {
  const l = new LoginLimiter({ maxAttempts: 100, windowMs: 1000, globalMax: 5, now: () => 0 });
  for (let i = 0; i < 5; i++) l.fail(`10.0.0.${i}`);
  assert.ok(l.retryAfter('10.0.0.99') > 0);
});

test('State OAuth : usage unique, lié à la plateforme et au cookie, expirant', () => {
  let t = 0;
  const s = new OAuthStates({ ttlMs: 1000, now: () => t });
  const a = s.create('tiktok');
  assert.ok(a.state.length >= 32);
  assert.ok(s.consume(a.state, 'tiktok', a.nonce));
  assert.equal(s.consume(a.state, 'tiktok', a.nonce), null, 'rejeu refusé');

  const b = s.create('tiktok');
  assert.equal(s.consume(b.state, 'instagram', b.nonce), null, 'autre plateforme refusée');
  const c = s.create('linkedin');
  assert.equal(s.consume(c.state, 'linkedin', 'mauvais-nonce'), null, 'cookie navigateur différent refusé');
  const d = s.create('linkedin');
  t = 1001;
  assert.equal(s.consume(d.state, 'linkedin', d.nonce), null, 'expiré');
  assert.equal(s.consume('inconnu', 'linkedin', 'x'), null);
});

test('Cache TTL : expiration et déduplication des appels concurrents', async () => {
  let t = 0;
  const c = new TtlCache({ ttlMs: 100, now: () => t });
  let n = 0;
  const fn = async () => { n++; await new Promise((r) => setTimeout(r, 5)); return n; };
  const [x, y] = await Promise.all([c.wrap('k', fn), c.wrap('k', fn)]);
  assert.equal(x, 1); assert.equal(y, 1); assert.equal(n, 1);
  assert.equal(await c.wrap('k', fn), 1);
  t = 101;
  assert.equal(await c.wrap('k', fn), 2);
  c.invalidate('k');
  assert.equal(c.get('k'), undefined);
});
