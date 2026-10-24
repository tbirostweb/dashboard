/* Section « Google Analytics » de l'onglet Site web > Google (GA4 via l'API Analytics Data, appels faits par le backend : GET /api/ga4?range=7d|30d|12m).
   Indépendante de Search Console : états non configuré, erreur, aucune donnée encore, ou rapport (utilisateurs, sessions, pages vues, événements, courbe, pages, événements). */
import { esc, isNum, number, fmtDay } from '../core/format.js?v=17';
import { KpiCard, EmptyState, SectionHeader, ChartCard, StatusBadge, Alert, DataTable } from '../ui/components.js?v=17';
import { errorCard } from './connections.js?v=17';

const Charts = window.Charts;

function kpi(name, k, basis) {
  const none = !k || !isNum(k.value);
  const delta = !none && isNum(k.previous) && k.previous ? (k.value - k.previous) / k.previous * 100 : null;
  return KpiCard({ label: name, value: none ? null : number(k.value), delta, deltaUnit: 'percent', deltaLabel: 'vs période précédente', deltaReason: 'Pas de période précédente à comparer.', basis, hint: none ? 'Aucune donnée pour cette période.' : undefined });
}

const head = (badge, sub) => `<div class="an-head">${SectionHeader({ title: 'Google Analytics', sub, level: 2 })}<div class="an-head__tools">${badge}</div></div>`;

function table({ id, titre, rows, firstLabel, firstOf, countLabel, countKey, emptyCause }) {
  const h = SectionHeader({ title: titre, id: `${id}-h` });
  if (rows === null) return `<section class="card" aria-labelledby="${id}-h">${h}${EmptyState({ title: 'Section indisponible', cause: 'Google Analytics n’a pas répondu pour cette section. Réessayez dans un instant.' })}</section>`;
  if (!rows.length) return `<section class="card" aria-labelledby="${id}-h">${h}${EmptyState({ title: 'Aucune donnée sur la période', cause: emptyCause })}</section>`;
  return `<section class="card" aria-labelledby="${id}-h">${h}${DataTable({
    id, rows, pageSize: 5, sort: { key: countKey, dir: 'desc' }, caption: titre, csv: { filename: id },
    columns: [
      { key: 'key', label: firstLabel, value: firstOf, render: (r) => `<span class="seo-key" title="${esc(firstOf(r))}">${esc(firstOf(r))}</span>`, sortable: true, wrap: true },
      { key: countKey, label: countLabel, numeric: true, sortable: true, format: number },
      { key: 'users', label: 'Utilisateurs', numeric: true, sortable: true, format: number }
    ]
  })}</section>`;
}

const EVENT_LABELS = { cta_devis_click: 'Clic sur « Devis »', select_offer: 'Choix d’une offre', click_calcom: 'Clic Cal.com (rendez-vous)', click_social: 'Clic réseaux sociaux', generate_lead: 'Lead généré' };

/** Événements du site : toujours les cinq, même à zéro (un zéro est une information : le suivi est branché mais personne n'a cliqué). */
function siteEvents(rows) {
  const h = SectionHeader({ title: 'Événements du site', sub: 'Actions clés suivies sur birostweb.fr', id: 'ga-site-h' });
  if (rows === null) return `<section class="card" aria-labelledby="ga-site-h">${h}${EmptyState({ title: 'Section indisponible', cause: 'Google Analytics n’a pas répondu pour cette section. Réessayez dans un instant.' })}</section>`;
  return `<section class="card" aria-labelledby="ga-site-h">${h}<ul class="block-list">${rows.map((r) => `<li><span>${esc(EVENT_LABELS[r.name] || r.name)} <span class="muted">(${esc(r.name)})</span></span><strong>${number(r.count)}</strong><span class="muted">${number(r.users)} utilisateur${r.users > 1 ? 's' : ''}</span></li>`).join('')}</ul></section>`;
}

function chart(g, label) {
  const card = (inner) => ({ markup: `<section class="card">${SectionHeader({ title: 'Utilisateurs et pages vues', level: 2 })}${inner}</section>`, after() {} });
  if (g.series === null) return card(EmptyState({ title: 'Courbe indisponible', cause: 'Google Analytics n’a pas fourni la série chronologique.' }));
  const th = Charts.theme(), dates = g.series.map((p) => p.date);
  const series = [
    { label: 'Pages vues', data: g.series.map((p) => p.pageviews), color: th.ink, fill: true },
    { label: 'Utilisateurs', data: g.series.map((p) => p.users), color: th.gray, dashed: true }
  ];
  const sum = (k) => g.series.reduce((s, p) => s + p[k], 0);
  return {
    markup: ChartCard({ id: 'ga-line', title: 'Utilisateurs et pages vues', sub: `${label} · un point par jour`, legend: series.map((s) => ({ label: s.label, color: s.color, dash: s.dashed ? '4 4' : '' })),
      summary: `${label} : ${number(sum('pageviews'))} pages vues et jusqu’à ${number(Math.max(...g.series.map((p) => p.users)))} utilisateurs par jour.`,
      tableFallback: { caption: 'Utilisateurs, sessions et pages vues par jour', columns: ['Date', 'Utilisateurs', 'Sessions', 'Pages vues'], rows: g.series.map((p) => [fmtDay(p.date), number(p.users), number(p.sessions), number(p.pageviews)]) } }),
    after() { const c = document.getElementById('ga-line'); if (c) Charts.lines(c, { labels: dates, series }); }
  };
}

/** g : réponse de /api/ga4 (ou null) ; err : erreur de lecture (ApiError) quand g est null. Retourne { markup, after }. */
export function ga4Section(g, err, label) {
  if (!g) return { markup: `<div class="an-head">${SectionHeader({ title: 'Google Analytics', level: 2 })}</div>${errorCard(err)}`, after() {} };
  if (g.status === 'not_configured') {
    const list = (g.missing || []).map((m) => `<li><code>${esc(m)}</code></li>`).join('');
    return { markup: `<section class="card" aria-labelledby="ga-nc"><div class="card__head"><div><h2 class="card__title" id="ga-nc">Google Analytics non configuré</h2><span class="card__sub">Utilisateurs, sessions, pages vues et événements (GA4).</span></div>${StatusBadge({ kind: 'neutral', label: 'Non configuré' })}</div>
      <p>Renseignez ces variables d’environnement du service <code>api</code> (Dokploy &gt; Environment), puis redéployez :</p><ul class="an-missing">${list}</ul>
      <p class="muted">Le compte de service est le même que pour Search Console. <code>GA4_PROPERTY_ID</code> est l’identifiant <strong>numérique</strong> de la propriété (Analytics &gt; Admin &gt; Paramètres de la propriété), pas l’identifiant de mesure « G-… ». Détails : <code>.env.example</code> et <code>connexion.md</code>.</p></section>`, after() {} };
  }
  if (g.status !== 'ok') {
    return { markup: `${head(StatusBadge({ kind: 'error', label: 'Erreur' }), '')}<section class="card">${Alert({ kind: 'error', title: 'Google Analytics indisponible.', html: esc(g.message || 'Les statistiques n’ont pas pu être lues.') })}<p class="muted an-hint">Vérifiez GA4_PROPERTY_ID et l’accès du compte de service à la propriété GA4.</p></section>`, after() {} };
  }
  const t = g.totals || {}, active = [t.users, t.sessions, t.pageviews, t.events].some((k) => k && isNum(k.value) && k.value > 0);
  const badge = StatusBadge({ kind: 'ok', label: 'Connecté' });
  const intro = head(badge, `${label} · propriété GA4 connectée`);
  if (!active) {
    return { markup: `${intro}<section class="card">${EmptyState({ title: 'Aucune donnée Google Analytics pour l’instant', cause: 'La connexion fonctionne, mais aucune visite n’est encore enregistrée. Vérifiez que le script GA4 est installé sur le site et que le visiteur a accepté les cookies ; les premières données apparaissent dans le rapport Temps réel de Google Analytics, puis ici sous 24 à 48 h.' })}</section>`, after() {} };
  }
  const c = chart(g, label);
  return {
    markup: `${intro}
      <section class="kpis kpis--4" aria-label="Indicateurs Google Analytics">
        ${kpi('Utilisateurs', t.users, 'Utilisateurs actifs distincts sur la période (GA4).')}
        ${kpi('Sessions', t.sessions, 'Nombre de sessions de navigation.')}
        ${kpi('Pages vues', t.pageviews, 'Nombre de pages affichées (écrans vus).')}
        ${kpi('Événements', t.events, 'Tous les événements GA4 : pages vues, clics sortants, devis, contact, formulaires, téléchargements…')}
      </section>
      ${c.markup}
      <div class="an-grid">
        ${table({ id: 'ga-pages', titre: 'Pages les plus consultées', rows: g.pages, firstLabel: 'Page', firstOf: (r) => r.path || '/', countLabel: 'Pages vues', countKey: 'views', emptyCause: 'Aucune page vue enregistrée sur la période.' })}
        ${table({ id: 'ga-sources', titre: 'Sources de trafic', rows: g.sources, firstLabel: 'Source', firstOf: (r) => r.source === '(direct)' ? 'Direct' : r.source, countLabel: 'Sessions', countKey: 'sessions', emptyCause: 'Aucune source enregistrée sur la période.' })}
        ${siteEvents(g.siteEvents)}
        ${table({ id: 'ga-events', titre: 'Tous les événements', rows: g.events, firstLabel: 'Événement', firstOf: (r) => r.name, countLabel: 'Occurrences', countKey: 'count', emptyCause: 'Aucun événement enregistré sur la période.' })}
      </div>`,
    after: c.after
  };
}
