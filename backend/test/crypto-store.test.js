import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { encrypt, decrypt, safeEqual } from '../src/crypto.js';
import { Store } from '../src/store.js';
import { assertSecrets, loadConfig, ConfigError } from '../src/config.js';
import { tmpDir, TEST_KEY } from './helpers.js';

test('AES-256-GCM : aller-retour, altération détectée, mauvaise clé refusée', () => {
  const box = encrypt('secret-token-value', TEST_KEY);
  assert.equal(box.alg, 'aes-256-gcm');
  assert.ok(!JSON.stringify(box).includes('secret-token-value'));
  assert.equal(decrypt(box, TEST_KEY), 'secret-token-value');

  const tampered = { ...box, data: Buffer.from('xxxxxxxxxxxxxxxxxx').toString('base64') };
  assert.throws(() => decrypt(tampered, TEST_KEY));
  assert.throws(() => decrypt(box, 'c'.repeat(64)));
  // IV aléatoire : deux chiffrements différents
  assert.notEqual(encrypt('x', TEST_KEY).data + encrypt('x', TEST_KEY).iv, box.data + box.iv);
});

test('safeEqual compare correctement (longueurs différentes incluses)', () => {
  assert.equal(safeEqual('abc', 'abc'), true);
  assert.equal(safeEqual('abc', 'abd'), false);
  assert.equal(safeEqual('abc', 'abcd'), false);
  assert.equal(safeEqual('', undefined), true);
  assert.equal(safeEqual('a', undefined), false);
});

test('Store : fichier chiffré sur disque, relu correctement, permissions 0600', async () => {
  const dir = tmpDir();
  const s = new Store({ dataDir: dir, keyHex: TEST_KEY });
  await s.setToken('tiktok', { accessToken: 'act.SUPERSECRET', refreshToken: 'rft.SUPERSECRET', expiresAt: 123 });
  await s.recordSnapshot('tiktok', '2026-09-30', 1234);

  const file = path.join(dir, 'store.enc.json');
  const raw = fs.readFileSync(file, 'utf8');
  assert.ok(!raw.includes('SUPERSECRET'), 'le token ne doit pas apparaître en clair');
  assert.ok(!raw.includes('1234'));
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);

  const s2 = new Store({ dataDir: dir, keyHex: TEST_KEY });
  assert.equal((await s2.getToken('tiktok')).accessToken, 'act.SUPERSECRET');
  assert.deepEqual(await s2.getSnapshots('tiktok'), { '2026-09-30': 1234 });

  const wrong = new Store({ dataDir: dir, keyHex: 'd'.repeat(64) });
  await assert.rejects(() => wrong.load(), /TOKEN_ENCRYPTION_KEY/);

  await s2.deleteToken('tiktok');
  assert.equal(await new Store({ dataDir: dir, keyHex: TEST_KEY }).getToken('tiktok'), null);
});

test('Configuration : secrets faibles ou absents refusés (fail-closed)', () => {
  assert.throws(() => assertSecrets(loadConfig({})), ConfigError);
  assert.throws(() => assertSecrets(loadConfig({ DASHBOARD_PASSWORD: 'court', SESSION_SECRET: 'x'.repeat(40), TOKEN_ENCRYPTION_KEY: TEST_KEY })), /DASHBOARD_PASSWORD/);
  assert.throws(() => assertSecrets(loadConfig({ DASHBOARD_PASSWORD: 'x'.repeat(14), SESSION_SECRET: 'x'.repeat(40), TOKEN_ENCRYPTION_KEY: 'pas-hex' })), /TOKEN_ENCRYPTION_KEY/);
  assert.throws(() => assertSecrets(loadConfig({ DASHBOARD_PASSWORD: 'remplacez-moi-par-une-longue-phrase', SESSION_SECRET: 'a-generer-avec-openssl-rand-hex-32', TOKEN_ENCRYPTION_KEY: '1'.repeat(64) })), /valeur d'exemple/);
  assert.doesNotThrow(() => assertSecrets(loadConfig({ DASHBOARD_PASSWORD: 'une phrase de passe solide', SESSION_SECRET: 'PUBLIC_TEST_PLACEHOLDER_3', TOKEN_ENCRYPTION_KEY: TEST_KEY })));
  const cfg = loadConfig({ PUBLIC_URL: 'https://a.example/' });
  assert.equal(cfg.tiktok.redirectUri, 'https://a.example/api/auth/tiktok/callback');
  assert.equal(cfg.secureCookies, true);
  assert.equal(loadConfig({ PUBLIC_URL: 'http://localhost:8080' }).secureCookies, false);
});
