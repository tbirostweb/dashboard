// Audit SEO du site : analyse des balises, robots.txt / sitemap.xml, limites de sécurité (même hôte seulement), route protégée.
import test from 'node:test';
import assert from 'node:assert/strict';
import { SiteAudit, analyzeHtml, siteOriginOf } from '../src/siteaudit.js';
import { fakeFetch, makeApp, login, testConfig } from './helpers.js';

const ORIGIN = 'https://exemple.test';
const GOOD = `<!doctype html><html lang="fr"><head><title>Développeur web freelance | Sites sur mesure — Exemple</title>
<meta name="description" content="Création et refonte de sites web pour indépendants et petites entreprises, partout en France. Devis gratuit sous 48h.">
<meta name="viewport" content="width=device-width"><meta name="robots" content="index, follow"><link rel="canonical" href="${ORIGIN}/">
<meta property="og:title" content="x"><meta content="https://exemple.test/og.png" property="og:image"><meta name="twitter:card" content="summary">
<script type="application/ld+json">{"@context":"https://schema.org","@graph":[{"@type":"WebSite"},{"@type":["Organization","ProfessionalService"]}]}</script></head>
<body><h1>Titre</h1><img src="a.png" alt="a"><p>${'mot '.repeat(200)}</p></body></html>`;

test('analyse : page saine = aucun problème ; types JSON-LD, balises meta dans n’importe quel ordre', () => {
  const p = analyzeHtml(GOOD, { url: `${ORIGIN}/`, status: 200 });
  assert.deepEqual(p.issues, []);
  assert.equal(p.score, 100);
  assert.deepEqual(p.schemaTypes.sort(), ['Organization', 'ProfessionalService', 'WebSite']);
  assert.equal(p.og.image, true);
});

test('analyse : problèmes détectés (noindex, titre/description/H1/alt/JSON-LD manquants)', () => {
  const bad = '<html><head><meta name="robots" content="noindex"><title>x</title></head><body><h1>a</h1><h1>b</h1><img src="a.png"></body></html>';
  const p = analyzeHtml(bad, { url: `${ORIGIN}/x`, status: 200 });
  const text = p.issues.map((i) => i.text).join(' | ');
  for (const re of [/noindex/, /Titre de 1 caractères/, /Meta description absente/, /2 titres H1/, /viewport/, /Aucune donnée structurée/, /1 image sans attribut alt/, /Peu de texte/]) assert.match(text, re);
  assert.ok(p.score < 50);
});

test('siteOriginOf : domaine, URL, valeurs invalides', () => {
  assert.equal(siteOriginOf('sc-domain:Exemple.fr'), 'https://exemple.fr');
  assert.equal(siteOriginOf('https://exemple.fr/chemin/'), 'https://exemple.fr');
  assert.equal(siteOriginOf('javascript:alert(1)'), '');
  assert.equal(siteOriginOf(''), '');
});

test('audit : robots, sitemap, pages du même hôte uniquement, aucune lecture hors domaine', async () => {
  const f = fakeFetch([
    [/robots\.txt/, () => ({ body: 'User-agent: *\nAllow: /\nSitemap: https://exemple.test/sitemap.xml\n' })],
    [/sitemap\.xml/, () => ({ body: `<urlset><url><loc>${ORIGIN}/</loc></url><url><loc>${ORIGIN}/galerie</loc></url><url><loc>https://evil.test/x</loc></url></urlset>` })],
    [/exemple\.test\/galerie/, () => ({ body: '<html><head><title>x</title></head><body></body></html>' })],
    [/exemple\.test\/$/, () => ({ body: GOOD })]
  ]);
  const r = await new SiteAudit({ origin: ORIGIN, fetch: f, now: () => 1 }).report();
  assert.equal(r.site.robots.declaresSitemap, true);
  assert.equal(r.site.robots.blocksAll, false);
  assert.equal(r.site.sitemap.urls, 3);
  assert.deepEqual(r.pages.map((p) => p.path), ['/', '/galerie']);
  assert.ok(!f.calls.some((c) => c.url.includes('evil.test')));
  assert.equal(r.pages[0].score, 100);
  assert.ok(r.pages[1].score < 100);
  assert.ok(r.summary.errors > 0);
});

test('page injoignable : une erreur, pas de plantage ; robots « Disallow: / » détecté', async () => {
  const f = fakeFetch([
    [/robots\.txt/, () => ({ body: 'User-agent: *\nDisallow: /\n' })],
    [/sitemap\.xml/, () => ({ status: 404, body: '' })],
    [/exemple\.test\/$/, () => { throw new Error('réseau'); }]
  ]);
  const r = await new SiteAudit({ origin: ORIGIN, fetch: f, now: () => 1 }).report();
  assert.equal(r.site.robots.blocksAll, true);
  assert.equal(r.site.sitemap.found, false);
  assert.equal(r.pages[0].status, 0);
  assert.match(r.pages[0].issues[0].text, /injoignable/i);
});

test('GET /api/site-health : protégé ; non configuré sans GSC_SITE_URL ; résultat avec audit injecté', async () => {
  const off = makeApp();
  assert.equal((await off.app.inject({ method: 'GET', url: '/api/site-health' })).statusCode, 401);
  const c0 = await login(off.app);
  assert.equal((await off.app.inject({ method: 'GET', url: '/api/site-health', headers: { cookie: c0 } })).json().status, 'not_configured');
  const cfg = testConfig({ GSC_SITE_URL: 'sc-domain:exemple.test' });
  const stub = { report: async () => ({ origin: ORIGIN, pages: [], site: {}, summary: { pages: 0, errors: 0, warnings: 0, score: 0 } }) };
  const { app } = makeApp({ cfg, siteAudit: stub });
  const cookie = await login(app);
  const r = (await app.inject({ method: 'GET', url: '/api/site-health', headers: { cookie } })).json();
  assert.equal(r.status, 'ok');
  assert.equal(r.sitemaps, null, 'Search Console non configuré : section absente, l’audit reste affiché');
});
