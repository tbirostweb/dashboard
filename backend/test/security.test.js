import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSession, verifySession, LoginLimiter, OAuthStates, parseCookies, serializeCookie, createDeviceToken, verifyDeviceToken } from '../src/security.js';
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

test('Anti brute-force : limite globale (attaque distribuée) relevée, appareils connus exemptés', () => {
  const l = new LoginLimiter({ maxAttempts: 100, windowMs: 1000, globalMax: 5, now: () => 0 });
  for (let i = 0; i < 5; i++) l.fail(`10.0.0.${i}`);
  assert.ok(l.retryAfter('10.0.0.99') > 0, 'appareil inconnu bloqué au seuil global');
  assert.equal(l.retryAfter('10.0.0.99', { knownDevice: true }), 0, 'appareil connu jamais bloqué par la limite globale');
  assert.equal(new LoginLimiter().globalMax, 500, 'seuil global par défaut relevé');
});

test('Anti brute-force : une IP au-delà de son quota n’alimente pas la limite globale ; ralentissement progressif', () => {
  const l = new LoginLimiter({ maxAttempts: 3, windowMs: 1000, globalMax: 5, now: () => 0 });
  for (let i = 0; i < 20; i++) l.fail('9.9.9.9');
  assert.equal(l.retryAfter('8.8.8.8'), 0, 'une seule IP ne peut pas bloquer tout le monde');
  const p = new LoginLimiter({ maxAttempts: 10, windowMs: 1000, globalMax: 1000, maxDelayMs: 5000, now: () => 0 });
  const delays = [];
  for (let i = 0; i < 5; i++) { p.fail('1.1.1.1'); delays.push(p.failDelay('1.1.1.1', 400)); }
  assert.deepEqual(delays, [400, 800, 1600, 3200, 3200]);
  assert.equal(p.failDelay('1.1.1.1', 0), 0, 'aucun délai si désactivé');
});

test('Cookie d’appareil : signé, expirant, distinct d’un jeton de session', () => {
  const t0 = 1_000_000;
  const v = createDeviceToken(SECRET, t0);
  assert.equal(verifyDeviceToken(v, SECRET, t0 + 1000), true);
  assert.equal(verifyDeviceToken(v, 'autre'.repeat(10), t0), false);
  assert.equal(verifyDeviceToken(v, SECRET, t0 + 181 * 86_400_000), false, 'expiré');
  assert.equal(verifyDeviceToken(createSession(SECRET, 60_000, t0), SECRET, t0), false, 'jeton de session refusé comme appareil');
  assert.equal(verifyDeviceToken(undefined, SECRET, t0), false);
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
