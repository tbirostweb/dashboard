// Audit SEO du site (birostweb.fr) lu par le serveur : robots.txt, sitemap.xml et balises des pages (titre, description, H1, canonical,
// Open Graph, données structurées, images sans alt…). Lecture seule, sans dépendance, sans exécution de JavaScript.
// Sécurité : l'origine auditée vient UNIQUEMENT de GSC_SITE_URL (jamais d'une requête) ; seules les URL de ce même hôte sont lues.
import { ProviderError } from './http.js';

const MAX_PAGES = 8;
const MAX_BYTES = 1_500_000;
const TIMEOUT_MS = 10_000;
const UA = 'BirostwebDashboardSEO/1.0 (+audit en lecture seule)';

/** « sc-domain:exemple.fr » → https://exemple.fr ; « https://exemple.fr/chemin » → https://exemple.fr ; autre chose → ''. */
export function siteOriginOf(siteUrl) {
  const s = String(siteUrl || '').trim();
  const d = s.match(/^sc-domain:([a-z0-9.-]+)$/i);
  if (d) return `https://${d[1].toLowerCase()}`;
  try { const u = new URL(s); return /^https?:$/.test(u.protocol) ? u.origin : ''; } catch { return ''; }
}

const decode = (t) => String(t ?? '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/\s+/g, ' ').trim();
const attr = (tag, name) => { const m = tag.match(new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i')); return m ? decode(m[2] ?? m[3] ?? m[4]) : null; };
/** Contenu d'une balise <meta> repérée par name= ou property= (ordre des attributs libre). */
function meta(html, key) {
  for (const m of html.matchAll(/<meta\b[^>]*>/gi)) {
    const tag = m[0], k = (attr(tag, 'name') || attr(tag, 'property') || '').toLowerCase();
    if (k === key) return attr(tag, 'content');
  }
  return null;
}
const linkHref = (html, rel) => { for (const m of html.matchAll(/<link\b[^>]*>/gi)) if ((attr(m[0], 'rel') || '').toLowerCase().split(/\s+/).includes(rel)) return attr(m[0], 'href'); return null; };

export function analyzeHtml(html, { url, status, headers = {}, ms = 0 }) {
  const title = (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1];
  const description = meta(html, 'description'), robots = (meta(html, 'robots') || '').toLowerCase(), xRobots = String(headers['x-robots-tag'] || '').toLowerCase();
  const body = html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, ' ');
  const h1 = (body.match(/<h1\b/gi) || []).length;
  const imgs = [...body.matchAll(/<img\b[^>]*>/gi)].map((m) => m[0]), missingAlt = imgs.filter((t) => attr(t, 'alt') === null).length;
  const types = [];
  for (const m of html.matchAll(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const walk = (n) => { if (Array.isArray(n)) n.forEach(walk); else if (n && typeof n === 'object') { if (n['@type']) types.push(...[].concat(n['@type']).map(String)); walk(n['@graph']); } };
      walk(JSON.parse(m[1]));
    } catch { types.push('(JSON-LD invalide)'); }
  }
  const lang = (html.match(/<html\b[^>]*>/i) || [''])[0], canonical = linkHref(html, 'canonical');
  const words = decode(body.replace(/<[^>]+>/g, ' ')).split(' ').filter(Boolean).length;
  const page = {
    url, path: (() => { try { const u = new URL(url); return u.pathname + u.search || '/'; } catch { return url; } })(), status, ms,
    title: { text: title ? decode(title) : '', length: title ? decode(title).length : 0 },
    description: { length: description ? description.length : 0 },
    h1, canonical, lang: attr(lang, 'lang'), viewport: Boolean(meta(html, 'viewport')),
    og: { title: Boolean(meta(html, 'og:title')), image: Boolean(meta(html, 'og:image')), description: Boolean(meta(html, 'og:description')) },
    twitterCard: Boolean(meta(html, 'twitter:card')), schemaTypes: [...new Set(types)], images: { total: imgs.length, missingAlt }, words,
    noindex: /noindex/.test(robots) || /noindex/.test(xRobots)
  };
  page.issues = issuesOf(page);
  const bad = page.issues.filter((i) => i.level === 'error').length, warn = page.issues.filter((i) => i.level === 'warn').length;
  page.score = Math.max(0, 100 - bad * 25 - warn * 8);
  return page;
}

function issuesOf(p) {
  const out = [], add = (level, text) => out.push({ level, text });
  if (p.status !== 200) add('error', `Réponse HTTP ${p.status || 'absente'} (200 attendu).`);
  if (p.noindex) add('error', 'La page est en « noindex » : Google ne l’indexera pas.');
  if (!p.title.length) add('error', 'Balise <title> absente.');
  else if (p.title.length < 30 || p.title.length > 65) add('warn', `Titre de ${p.title.length} caractères (30 à 65 recommandés pour ne pas être tronqué).`);
  if (!p.description.length) add('error', 'Meta description absente.');
  else if (p.description.length < 70 || p.description.length > 160) add('warn', `Meta description de ${p.description.length} caractères (70 à 160 recommandés).`);
  if (p.h1 === 0) add('error', 'Aucun titre H1.');
  else if (p.h1 > 1) add('warn', `${p.h1} titres H1 (un seul recommandé).`);
  if (!p.canonical) add('warn', 'Pas d’URL canonique.');
  else { try { if (new URL(p.canonical, p.url).origin + new URL(p.canonical, p.url).pathname.replace(/\/$/, '') !== new URL(p.url).origin + new URL(p.url).pathname.replace(/\/$/, '')) add('warn', `L’URL canonique pointe ailleurs (${p.canonical}).`); } catch { add('warn', 'URL canonique invalide.'); } }
  if (!p.lang) add('warn', 'Attribut lang absent sur <html>.');
  if (!p.viewport) add('error', 'Balise viewport absente (affichage mobile).');
  if (!p.og.title || !p.og.image) add('warn', 'Open Graph incomplet (titre ou image) : l’aperçu sur les réseaux sera pauvre.');
  if (!p.twitterCard) add('warn', 'Balise twitter:card absente.');
  if (!p.schemaTypes.length) add('warn', 'Aucune donnée structurée (JSON-LD).');
  if (p.images.missingAlt) add('warn', `${p.images.missingAlt} image${p.images.missingAlt > 1 ? 's' : ''} sans attribut alt.`);
  if (p.words < 150) add('warn', `Peu de texte (${p.words} mots) : Google a besoin de contenu pour comprendre la page.`);
  return out;
}

export class SiteAudit {
  constructor({ origin, fetch = globalThis.fetch, now = () => Date.now(), cacheSeconds = 900 }) {
    Object.assign(this, { origin, fetch, now, cacheSeconds });
    this.cache = null;
  }

  async get(url) {
    const t0 = this.now();
    let res;
    try { res = await this.fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(TIMEOUT_MS), headers: { 'user-agent': UA, accept: 'text/html,application/xml,text/plain' } }); }
    catch { throw new ProviderError('siteaudit', 'network', 'Site injoignable depuis le serveur du dashboard.'); }
    const final = res.url || url;
    if (new URL(final).origin !== this.origin) throw new ProviderError('siteaudit', 'upstream', 'Redirection vers un autre domaine : page ignorée.');
    const buf = Buffer.from(await res.arrayBuffer()).subarray(0, MAX_BYTES);
    const headers = {}; res.headers.forEach((v, k) => { headers[k.toLowerCase()] = v; });
    return { status: res.status, url: final, text: buf.toString('utf8'), ms: Math.max(0, this.now() - t0), headers };
  }

  report() {
    if (this.cache && (this.cache.promise || this.now() - this.cache.at < this.cacheSeconds * 1000)) return this.cache.promise || Promise.resolve(this.cache.value);
    const promise = this.build().then((value) => { this.cache = { at: this.now(), value }; return value; }, (e) => { this.cache = null; throw e; });
    this.cache = { promise, at: 0 };
    return promise;
  }

  async build() {
    const [robotsR, sitemapR] = await Promise.allSettled([this.get(`${this.origin}/robots.txt`), this.get(`${this.origin}/sitemap.xml`)]);
    const robots = robotsR.status === 'fulfilled' && robotsR.value.status === 200 ? robotsR.value.text : null;
    const sm = sitemapR.status === 'fulfilled' && sitemapR.value.status === 200 ? sitemapR.value.text : null;
    const locs = sm ? [...sm.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map((m) => decode(m[1])) : [];
    const sameHost = locs.filter((u) => { try { return new URL(u).origin === this.origin; } catch { return false; } });
    const urls = [...new Set([`${this.origin}/`, ...sameHost])].slice(0, MAX_PAGES);
    const pages = await Promise.all(urls.map(async (u) => {
      try { const r = await this.get(u); return analyzeHtml(r.text, { url: r.url, status: r.status, headers: r.headers, ms: r.ms }); }
      catch (e) { return { url: u, path: new URL(u).pathname || '/', status: 0, ms: 0, title: { text: '', length: 0 }, description: { length: 0 }, h1: 0, schemaTypes: [], images: { total: 0, missingAlt: 0 }, issues: [{ level: 'error', text: e.message }], score: 0 }; }
    }));
    const issues = pages.flatMap((p) => p.issues);
    return {
      origin: this.origin, auditedAt: new Date(this.now()).toISOString(),
      site: {
        https: this.origin.startsWith('https://'),
        robots: { found: robots !== null, blocksAll: robots ? /^\s*disallow:\s*\/\s*$/im.test(robots) && /^\s*user-agent:\s*\*\s*$/im.test(robots) : false, declaresSitemap: robots ? /^\s*sitemap:\s*\S+/im.test(robots) : false },
        sitemap: { found: sm !== null, urls: locs.length, audited: urls.length, truncated: sameHost.length + 1 > MAX_PAGES }
      },
      pages, summary: { pages: pages.length, errors: issues.filter((i) => i.level === 'error').length, warnings: issues.filter((i) => i.level === 'warn').length, score: pages.length ? Math.round(pages.reduce((s, p) => s + p.score, 0) / pages.length) : 0 }
    };
  }
}
