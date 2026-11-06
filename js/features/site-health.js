/* Section « Santé SEO du site » de l'onglet Site web > Google : audit des pages de birostweb.fr fait par le serveur du dashboard
   (GET /api/site-health) + statut des sitemaps dans Search Console. Chaque page reçoit une note et la liste de ses problèmes. */
import { esc, number, fmtDateTime, relTime } from '../core/format.js?v=18';
import { EmptyState, SectionHeader, StatusBadge, Alert, DataTable, Details } from '../ui/components.js?v=18';
import { errorCard } from './connections.js?v=18';

const kindOfScore = (s) => (s >= 90 ? 'ok' : s >= 60 ? 'warn' : 'error');
const lvl = (l) => (l === 'error' ? 'error' : 'warn');
const headBlock = (badge, sub) => `<div class="an-head">${SectionHeader({ title: 'Santé SEO du site', sub, level: 2 })}<div class="an-head__tools">${badge || ''}</div></div>`;

function siteChecks(h) {
  const s = h.site || {}, rows = [];
  rows.push([s.https ? 'ok' : 'error', 'HTTPS', s.https ? 'Le site est servi en HTTPS.' : 'Le site n’est pas en HTTPS.']);
  rows.push([s.robots && s.robots.found ? (s.robots.blocksAll ? 'error' : 'ok') : 'warn', 'robots.txt', !s.robots || !s.robots.found ? 'Fichier robots.txt introuvable.' : s.robots.blocksAll ? 'Le fichier bloque tout le site (Disallow: /).' : s.robots.declaresSitemap ? 'Présent, autorise l’exploration et déclare le sitemap.' : 'Présent, mais ne déclare pas le sitemap.']);
  rows.push([s.sitemap && s.sitemap.found ? 'ok' : 'error', 'sitemap.xml', !s.sitemap || !s.sitemap.found ? 'Sitemap introuvable : Google découvre moins bien vos pages.' : `${number(s.sitemap.urls)} URL listée${s.sitemap.urls > 1 ? 's' : ''}${s.sitemap.truncated ? ` (${number(s.sitemap.audited)} auditées)` : ''}.`]);
  if (Array.isArray(h.sitemaps)) {
    if (!h.sitemaps.length) rows.push(['warn', 'Sitemap dans Search Console', 'Aucun sitemap déclaré dans Search Console : soumettez-le (Indexation > Sitemaps).']);
    for (const m of h.sitemaps) {
      const bad = m.errors > 0, warn = m.warnings > 0 || m.pending || !m.lastDownloaded;
      const last = m.lastDownloaded ? `lu par Google ${relTime(m.lastDownloaded)}` : 'pas encore lu par Google';
      rows.push([bad ? 'error' : warn ? 'warn' : 'ok', 'Sitemap dans Search Console', `${m.path.replace(/^https?:\/\/[^/]+/, '') || m.path} : ${last} · ${number(m.submitted)} URL soumise${m.submitted > 1 ? 's' : ''} · ${number(m.errors)} erreur${m.errors > 1 ? 's' : ''}, ${number(m.warnings)} avertissement${m.warnings > 1 ? 's' : ''}.`]);
    }
  }
  return `<ul class="block-list health-checks">${rows.map(([k, t, d]) => `<li>${StatusBadge({ kind: k, label: k === 'ok' ? 'OK' : k === 'warn' ? 'À voir' : 'Problème' })}<strong>${esc(t)}</strong><span class="muted">${esc(d)}</span></li>`).join('')}</ul>`;
}

function pagesTable(pages) {
  return DataTable({
    id: 'health-pages', rows: pages, pageSize: 8, sort: { key: 'score', dir: 'asc' }, caption: 'Audit SEO par page', csv: { filename: 'audit-seo' },
    columns: [
      { key: 'path', label: 'Page', value: (p) => p.path, render: (p) => `<span class="seo-key">${esc(p.path)}</span>`, sortable: true, wrap: true },
      { key: 'score', label: 'Note', numeric: true, sortable: true, render: (p) => StatusBadge({ kind: kindOfScore(p.score), label: `${p.score}/100` }), value: (p) => p.score },
      { key: 'status', label: 'HTTP', numeric: true, sortable: true, format: (v) => (v ? String(v) : 'n.d.') },
      { key: 'title', label: 'Titre', numeric: true, sortable: true, value: (p) => p.title.length, format: (v) => `${v} car.` },
      { key: 'desc', label: 'Description', numeric: true, sortable: true, value: (p) => p.description.length, format: (v) => `${v} car.` },
      { key: 'schema', label: 'Données structurées', sortable: false, render: (p) => esc(p.schemaTypes.length ? p.schemaTypes.join(', ') : 'Aucune'), csv: (p) => p.schemaTypes.join(' ') },
      { key: 'issues', label: 'Problèmes', numeric: true, sortable: true, value: (p) => p.issues.length, format: (v) => String(v) }
    ]
  });
}

const issuesBlock = (pages) => pages.filter((p) => p.issues.length).map((p) => Details({
  summary: `${p.path} : ${p.issues.length} point${p.issues.length > 1 ? 's' : ''} à voir`, className: 'health-issues',
  html: `<ul class="block-list">${p.issues.map((i) => `<li>${StatusBadge({ kind: lvl(i.level), label: i.level === 'error' ? 'Problème' : 'À voir' })}<span>${esc(i.text)}</span></li>`).join('')}</ul>`
})).join('');

/** h : réponse de /api/site-health (ou null) ; err : erreur de lecture quand h est null. */
export function healthSection(h, err) {
  if (!h) return `${headBlock('', '')}${errorCard(err)}`;
  if (h.status === 'not_configured') return `<section class="card">${headBlock(StatusBadge({ kind: 'neutral', label: 'Non configuré' }), '')}<p class="muted">L’audit lit le site défini par <code>GSC_SITE_URL</code>.</p></section>`;
  if (h.status !== 'ok') return `${headBlock(StatusBadge({ kind: 'error', label: 'Erreur' }), '')}<section class="card">${Alert({ kind: 'error', title: 'Audit indisponible.', html: esc(h.message || 'Le site n’a pas pu être lu.') })}</section>`;
  const sm = h.summary || {}, pages = h.pages || [];
  const badge = StatusBadge({ kind: kindOfScore(sm.score), label: `Note ${sm.score}/100` });
  const sub = `${esc(h.origin.replace(/^https?:\/\//, ''))} · ${number(sm.pages)} page${sm.pages > 1 ? 's' : ''} auditée${sm.pages > 1 ? 's' : ''} · ${number(sm.errors)} problème${sm.errors > 1 ? 's' : ''}, ${number(sm.warnings)} point${sm.warnings > 1 ? 's' : ''} à voir · ${esc(fmtDateTime(h.auditedAt))}`;
  return `<div class="an-head"><div><h2 class="section-head__title">Santé SEO du site</h2><span class="section-head__sub">${sub}</span></div><div class="an-head__tools">${badge}</div></div>
    <section class="card" aria-label="Contrôles du site">${siteChecks(h)}</section>
    <section class="card" aria-label="Audit des pages">${pages.length ? pagesTable(pages) : EmptyState({ title: 'Aucune page auditée', cause: 'Le sitemap est vide et la page d’accueil n’a pas pu être lue.' })}${issuesBlock(pages)}
      <p class="muted an-hint">Audit réalisé par le serveur du dashboard, sans exécuter JavaScript : une page entièrement générée côté navigateur peut sembler vide à Google comme ici.</p></section>`;
}
