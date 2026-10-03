// Outils de test : configuration factice, faux fetch (aucun appel réseau réel), construction de l'app.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/config.js';
import { Store } from '../src/store.js';
import { TtlCache } from '../src/cache.js';
import { createProviders } from '../src/providers/index.js';
import { createMockSource } from '../src/mock.js';
import { DataService } from '../src/service.js';
import { buildApp } from '../src/app.js';
import { Presence } from '../src/presence.js';
import { CallMeter } from '../src/meter.js';
import { CacheFile } from '../src/cachefile.js';

// Valeurs FACTICES, générées pour les tests uniquement
export const TEST_PASSWORD = 'mot-de-passe-de-test-123';
export const TEST_KEY = '0123456789abcdef'.repeat(4);
export const TEST_SECRET = 'test-session-secret-9c8b7a6f5e4d3c2b1a0f9e8d7c6b5a4f';

export function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sd-test-'));
}

export function testConfig(env = {}) {
  return loadConfig({
    NODE_ENV: 'test',
    PUBLIC_URL: 'https://dash.example.test',
    DATA_DIR: tmpDir(),
    DASHBOARD_PASSWORD: TEST_PASSWORD,
    SESSION_SECRET: TEST_SECRET,
    TOKEN_ENCRYPTION_KEY: TEST_KEY,
    TIKTOK_CLIENT_KEY: 'tt-client-key', TIKTOK_CLIENT_SECRET: 'tt-client-secret',
    INSTAGRAM_APP_ID: 'ig-app-id', INSTAGRAM_APP_SECRET: 'ig-app-secret',
    LINKEDIN_CLIENT_ID: 'li-client-id', LINKEDIN_CLIENT_SECRET: 'li-client-secret',
    ...env
  });
}

/**
 * Faux fetch : routes = [[RegExp | (url, init) => bool, (url, init) => ({ status?, json })], ...]
 * Toute URL non prévue lève une erreur (garantit qu'aucun appel réseau réel n'est tenté).
 */
export function fakeFetch(routes) {
  const calls = [];
  const fn = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    const hit = routes.find(([m]) => (m instanceof RegExp ? m.test(String(url)) : m(String(url), init)));
    if (!hit) throw new Error(`URL non mockée : ${String(url).split('?')[0]}`);
    const r = await hit[1](String(url), init);
    const status = r.status ?? 200;
    // r.body : corps brut (ex. chaîne vide) ; sinon r.json sérialisé
    const body = r.body !== undefined ? r.body : typeof r.json === 'string' ? r.json : JSON.stringify(r.json ?? {});
    return new Response(body, { status, headers: { 'Content-Type': 'application/json', ...(r.headers || {}) } });
  };
  fn.calls = calls;
  return fn;
}

export function makeApp({ env = {}, fetch = fakeFetch([]), now = () => Date.now(), cfg, logStream, dokploy, providers: providerOverrides, persist = false, scheduler } = {}) {
  cfg ||= testConfig(env);
  const store = new Store({ dataDir: cfg.dataDir, keyHex: cfg.tokenEncryptionKey });
  const providers = { ...createProviders(cfg, { fetch, now }), ...(providerOverrides || {}) };
  const cache = new TtlCache({ ttlMs: cfg.cacheTtlSeconds * 1000, now });
  const mock = createMockSource(cfg.mockPath, now);
  const silent = { info() {}, warn() {}, error() {}, debug() {} };
  const presence = new Presence({ windowMs: cfg.live.activeWindowSeconds * 1000, now });
  const meter = new CallMeter({ now });
  const cacheFile = persist ? new CacheFile({ dataDir: cfg.dataDir, keyHex: cfg.tokenEncryptionKey }) : null;
  const service = new DataService({ cfg, store, providers, cache, mock, logger: silent, now, meter, presence, cacheFile });
  const app = buildApp({ cfg, store, providers, service, now, logger: Boolean(logStream), logStream, failDelayMs: 0, dokploy, presence, scheduler });
  return { app, cfg, store, providers, service, cache, fetch, presence, meter, cacheFile };
}

export async function login(app, origin = 'https://dash.example.test') {
  const res = await app.inject({ method: 'POST', url: '/api/auth/login', headers: { origin }, payload: { password: TEST_PASSWORD } });
  if (res.statusCode !== 200) throw new Error(`login a échoué : ${res.statusCode}`);
  return String(res.headers['set-cookie']).split(';')[0];
}

/**
 * Fournisseur simulé (aucun réseau) : `fetchData` renvoie `raw()` (fonction appelée à chaque lecture réelle).
 * `calls.fetch` compte les lectures réelles auprès de la « plateforme ».
 */
export function stubProvider(id, raw, extra = {}) {
  const calls = { fetch: 0, refresh: 0 };
  return {
    id, label: id, calls,
    pendingApproval: false,
    capabilities: { comments: true },
    needsRefresh: () => false,
    refresh: async () => { calls.refresh++; return null; },
    revoke: async () => {},
    authorizeUrl: () => 'https://example.test/auth',
    exchangeCode: async () => { throw new Error('non utilisé'); },
    fetchData: async (token) => { calls.fetch++; return typeof raw === 'function' ? raw(token, calls.fetch) : raw; },
    ...extra
  };
}

/**
 * Horloge simulée : now(), setTimeout/clearTimeout déterministes, advance(ms) exécute les timers échus dans l'ordre
 * (en laissant les promesses se résoudre entre deux timers). Aucun temps réel n'est consommé.
 */
export class FakeClock {
  constructor(start = Date.parse('2026-10-01T10:00:00Z')) {
    this.t = start; this.timers = []; this.seq = 0;
    this.now = () => this.t;
    this.setTimeout = (fn, ms) => { const h = { id: ++this.seq, at: this.t + Math.max(0, ms), fn, unref() { return h; } }; this.timers.push(h); return h; };
    this.clearTimeout = (h) => { this.timers = this.timers.filter((x) => x !== h); };
  }
  // Laisse les promesses ET les E/S disque réelles (store chiffré) se terminer entre deux timers simulés.
  async flush() {
    for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
    await new Promise((r) => setTimeout(r, 4));
    for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
  }
  async advance(ms) {
    const end = this.t + ms;
    await this.flush();
    for (;;) {
      const due = this.timers.filter((h) => h.at <= end).sort((a, b) => a.at - b.at || a.id - b.id)[0];
      if (!due) break;
      this.timers = this.timers.filter((x) => x !== due);
      this.t = Math.max(this.t, due.at);
      due.fn();
      await this.flush();
    }
    this.t = end;
    await this.flush();
  }
}
