// sanitizeImageUrl, cohérence CSP (nginx.conf), configuration des nouvelles variables.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sanitizeImageUrl, sanitizeLinkUrl, ALL_IMAGE_SUFFIXES } from '../src/images.js';
import { projectDetails } from '../src/projection.js';
import { loadConfig } from '../src/config.js';
import { testConfig } from './helpers.js';
import { CANARY, tiktokRaw, instagramRaw, linkedinRaw } from './integration-fixtures.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

test('sanitizeImageUrl : hôtes de CDN valides acceptés', () => {
  const ok = [
    'https://scontent-cdg4-1.cdninstagram.com/v/t51/a.jpg?stp=dst&sig=1',
    'https://scontent.xx.fbcdn.net/v/x.jpg',
    'https://lookaside.fbsbx.com/lookaside/x',
    'https://p16-sign.tiktokcdn.com/obj/a.jpeg',
    'https://p19-sign.tiktokcdn-us.com/a.jpeg',
    'https://p16-sign-sg.tiktokcdn-eu.com/a.jpeg',
    'https://p16.ibytedtos.com/a.jpeg',
    'https://p16-sign.tiktok.com/a.jpeg',
    'https://media.licdn.com/dms/image/v2/abc/profile.jpg?e=1&v=beta&t=sig',
    'https://MEDIA.LICDN.COM/x.png'
  ];
  for (const u of ok) assert.ok(sanitizeImageUrl(u), u);
  assert.equal(sanitizeImageUrl('https://MEDIA.LICDN.COM/x.png'), 'https://media.licdn.com/x.png');
});

test('sanitizeImageUrl : refus (http, identifiants, fragment, port, hôtes piégés, schémas, entrées invalides)', () => {
  const bad = [
    'http://scontent.cdninstagram.com/a.jpg',
    'https://user:pass@scontent.cdninstagram.com/a.jpg',
    'https://user@scontent.cdninstagram.com/a.jpg',
    'https://scontent.cdninstagram.com/a.jpg#frag',
    'https://scontent.cdninstagram.com:8443/a.jpg',
    'https://evilfbcdn.net.attacker.com/a.jpg',
    'https://evilfbcdn.net/a.jpg',
    'https://fbcdn.net.attacker.com/a.jpg',
    'https://attacker.com/fbcdn.net/a.jpg',
    'https://attacker.com/?u=https://scontent.cdninstagram.com/a.jpg',
    'https://scontent.cdninstagram.com.attacker.com/a.jpg',
    'https://notlicdn.com/a.jpg',
    'https://licdn.com.evil.io/a.jpg',
    'https://scontent.cdninstagram.com@attacker.com/a.jpg',
    'https://attacker.com\\@scontent.cdninstagram.com/a.jpg',
    'https://scontent.cdninstagram.com./a.jpg',
    'https://127.0.0.1/a.jpg',
    'https://[::1]/a.jpg',
    'javascript:alert(1)',
    'data:image/png;base64,AAAA',
    '//scontent.cdninstagram.com/a.jpg',
    'https://scontent.cdninstagram.com/a b.jpg',
    'https://scontent.cdninstagram.com/a.jpg\n',
    `https://scontent.cdninstagram.com/${'a'.repeat(2100)}`,
    '', '   ', null, undefined, 42, {}, []
  ];
  for (const u of bad) assert.equal(sanitizeImageUrl(u), null, String(u).slice(0, 60));
});

test('sanitizeLinkUrl : https sans identifiants uniquement', () => {
  assert.ok(sanitizeLinkUrl('https://www.instagram.com/p/x/'));
  assert.equal(sanitizeLinkUrl('http://www.instagram.com/p/x/'), null);
  assert.equal(sanitizeLinkUrl('javascript:alert(1)'), null);
  assert.equal(sanitizeLinkUrl('https://u:p@www.instagram.com/'), null);
});

test('projection : avatar et images assainis, clés inconnues et secrets supprimés (canari)', () => {
  const t = Date.parse('2026-09-30T10:00:00Z');
  const raw = tiktokRaw(t).details;
  raw.profile.avatarUrl = 'https://evil.example.com/a.jpg';
  const out = projectDetails('tiktok', raw);
  assert.equal(out.profile.avatarUrl, null);
  assert.ok(!JSON.stringify(out).includes(CANARY.access) && !JSON.stringify(out).includes(CANARY.refresh) && !JSON.stringify(out).includes(CANARY.key));
  assert.equal(projectDetails('instagram', null), null);
  assert.equal(projectDetails('inconnue', { a: 1 }), null);
  // valeurs de mauvais type -> null (aucun objet fournisseur brut ne passe)
  const weird = projectDetails('instagram', { profile: { username: { evil: true }, followersCount: '12', mediaCount: Infinity }, notes: 'texte' });
  assert.deepEqual([weird.profile.username, weird.profile.followersCount, weird.profile.mediaCount, weird.notes], [null, null, null, null]);
  // LinkedIn : jeton/clé dans une facette « raw » supprimé
  const li = linkedinRaw(t).details;
  li.followers.facets.country = [{ key: { urn: 'urn:li:geo:1', accessToken: CANARY.access }, count: 3 }];
  const lo = projectDetails('linkedin', li);
  assert.ok(!JSON.stringify(lo).includes(CANARY.access));
  assert.equal(lo.followers.facets.country[0].count, 3);
  assert.ok(projectDetails('instagram', instagramRaw(t).details).profile);
});

test('CSP nginx : img-src = self + data: + suffixes CDN exacts ; aucune autre directive élargie', () => {
  const conf = fs.readFileSync(path.join(root, 'nginx.conf'), 'utf8');
  const csps = [...conf.matchAll(/set \$csp "([^"]+)"/g)].map((m) => m[1]);
  assert.equal(csps.length, 1);
  const dirs = Object.fromEntries(csps[0].split(';').map((d) => d.trim()).filter(Boolean).map((d) => { const [k, ...v] = d.split(/\s+/); return [k, v]; }));
  assert.deepEqual(dirs['img-src'].slice(0, 2), ["'self'", 'data:']);
  assert.deepEqual(dirs['img-src'].slice(2).sort(), ALL_IMAGE_SUFFIXES.map((s) => `https://*.${s}`).sort(), 'liste du CSP identique à celle de sanitizeImageUrl');
  assert.ok(dirs['img-src'].every((v) => v !== '*' && v !== 'https:' && v !== 'http:' && !v.startsWith('http://')));
  // directives inchangées
  assert.deepEqual(dirs['default-src'], ["'self'"]);
  // aucun script tiers (Chart.js auto-hébergé) ; polices auto-hébergées, aucun Google Fonts
  assert.deepEqual(dirs['script-src'], ["'self'"]);
  assert.deepEqual(dirs['style-src'], ["'self'", "'unsafe-inline'"]);
  assert.deepEqual(dirs['font-src'], ["'self'"]);
  assert.deepEqual(dirs['connect-src'], ["'self'"]);
  assert.deepEqual(dirs['object-src'], ["'none'"]);
  assert.deepEqual(dirs['frame-ancestors'], ["'none'"]);
  assert.deepEqual(dirs['form-action'], ["'self'"]);
  assert.deepEqual(dirs['base-uri'], ["'self'"]);
  // l'API garde une CSP fermée
  assert.match(conf, /Content-Security-Policy "default-src 'none'; frame-ancestors 'none'"/);
});

// ---------------------------------------------------------------------------- Configuration
test('config : défauts identiques à ceux des fournisseurs', () => {
  const c = testConfig();
  assert.deepEqual([c.instagram.insightMediaMax, c.instagram.commentMediaMax, c.instagram.insightConcurrency], [120, 30, 5]);
  assert.equal(c.tiktok.retryDelayMs, 500);
  const l = c.linkedin;
  assert.deepEqual([l.dailyCallBudget, l.priorityReserve, l.maxPostPages, l.pageStatsDays, l.pageStatsGranularity, l.reactionsMaxPosts, l.commentsMaxPosts, l.shareStatsListStyle], [80, 25, 5, 90, 'DAY', 15, 15, 'list']);
  assert.equal(l.cacheTtlSeconds, 43200);
  assert.equal(l.refreshIntervalHours, 12);
});

test('config : variables lues, validées et bornées ; valeurs invalides -> défaut', () => {
  const c = testConfig({
    INSTAGRAM_INSIGHT_MEDIA_MAX: '50', INSTAGRAM_COMMENT_MEDIA_MAX: '0', INSTAGRAM_INSIGHT_CONCURRENCY: '99',
    TIKTOK_RETRY_DELAY_MS: '-5',
    LINKEDIN_DAILY_CALL_BUDGET: '500', LINKEDIN_PRIORITY_RESERVE: '10', LINKEDIN_MAX_POST_PAGES: '0',
    LINKEDIN_PAGE_STATS_DAYS: 'abc', LINKEDIN_PAGE_STATS_GRANULARITY: 'month', LINKEDIN_REACTIONS_MAX_POSTS: '7',
    LINKEDIN_COMMENTS_MAX_POSTS: '1000', LINKEDIN_SHARE_STATS_LIST_STYLE: 'weird'
  });
  assert.equal(c.instagram.insightMediaMax, 50);
  assert.equal(c.instagram.commentMediaMax, 0);
  assert.equal(c.instagram.insightConcurrency, 10, 'borné à 10');
  assert.equal(c.tiktok.retryDelayMs, 0, 'borné à 0');
  assert.equal(c.linkedin.dailyCallBudget, 100, 'borné au quota Development tier');
  assert.equal(c.linkedin.priorityReserve, 10);
  assert.equal(c.linkedin.maxPostPages, 1);
  assert.equal(c.linkedin.pageStatsDays, 90, 'valeur invalide -> défaut');
  assert.equal(c.linkedin.pageStatsGranularity, 'MONTH');
  assert.equal(c.linkedin.reactionsMaxPosts, 7);
  assert.equal(c.linkedin.commentsMaxPosts, 100);
  assert.equal(c.linkedin.shareStatsListStyle, 'list');
  // réserve prioritaire jamais supérieure au budget
  assert.equal(loadConfig({ LINKEDIN_DAILY_CALL_BUDGET: '20', LINKEDIN_PRIORITY_RESERVE: '90' }).linkedin.priorityReserve, 20);
  assert.equal(loadConfig({ LINKEDIN_DAILY_CALL_BUDGET: '30' }).linkedin.priorityReserve, 10, 'défaut = un tiers du budget');
});

test('config : les variables sont transmises aux fournisseurs (cfg.<plateforme>.*)', async () => {
  const { createProviders } = await import('../src/providers/index.js');
  const cfg = testConfig({ INSTAGRAM_INSIGHT_MEDIA_MAX: '7', LINKEDIN_DAILY_CALL_BUDGET: '33' });
  const providers = createProviders(cfg, { fetch: async () => { throw new Error('réseau interdit'); } });
  assert.ok(providers.instagram && providers.linkedin);
  assert.equal(cfg.instagram.insightMediaMax, 7);
  assert.equal(cfg.linkedin.dailyCallBudget, 33);
});

test('.env.example et docker-compose.yml documentent toutes les nouvelles variables, sans valeur secrète', () => {
  const names = ['INSTAGRAM_INSIGHT_MEDIA_MAX', 'INSTAGRAM_COMMENT_MEDIA_MAX', 'INSTAGRAM_INSIGHT_CONCURRENCY', 'TIKTOK_RETRY_DELAY_MS',
    'LINKEDIN_DAILY_CALL_BUDGET', 'LINKEDIN_PRIORITY_RESERVE', 'LINKEDIN_MAX_POST_PAGES', 'LINKEDIN_PAGE_STATS_DAYS', 'LINKEDIN_PAGE_STATS_GRANULARITY',
    'LINKEDIN_REACTIONS_MAX_POSTS', 'LINKEDIN_COMMENTS_MAX_POSTS', 'LINKEDIN_SHARE_STATS_LIST_STYLE', 'LINKEDIN_CACHE_TTL_SECONDS', 'LINKEDIN_REFRESH_INTERVAL_HOURS'];
  const env = fs.readFileSync(path.join(root, '.env.example'), 'utf8');
  const compose = fs.readFileSync(path.join(root, 'docker-compose.yml'), 'utf8');
  for (const n of names) {
    assert.match(env, new RegExp(`^${n}=`, 'm'), `${n} absent de .env.example`);
    assert.match(compose, new RegExp(`^\\s+${n}: \\$\\{${n}:-`, 'm'), `${n} absent de docker-compose.yml`);
  }
});
