/* SEO (#/seo) : référencement de birostweb.fr dans Google, via Search Console (lecture seule, appels faits par le backend : GET /api/seo?range=7d|28d|90d).
   États : non configuré (variables manquantes), erreur Google, ou rapport (KPI avec variation, courbe clics / impressions, requêtes, pages). */
import { esc, isNum, number, pct, fmtDay } from '../core/format.js?v=17';
import { KpiCard, EmptyState, SectionHeader, ChartCard, StatusBadge, Alert, DataTable } from '../ui/components.js?v=17';
import { store } from '../core/state.js?v=17';
import { errorCard } from './connections.js?v=17';

const Api = window.Api, Charts = window.Charts;
export const title = 'SEO';
export const eyebrow = '';
export const usesToolbar = true; // sélecteur de période propre à la page

const RANGES = [['7d', '7 j', '7 derniers jours'], ['28d', '28 j', '28 derniers jours'], ['90d', '3 mois', '3 derniers mois']];
let range = (() => { const r = store.get('sd.seo.range'); return RANGES.some(([k]) => k === r) ? r : '28d'; })();

const label = () => RANGES.find(([k]) => k === range)[2];
const selector = () => `<div class="seg an-range" id="seo-range" role="group" aria-label="Période des statistiques">${RANGES.map(([k, short]) => `<button type="button" data-seo-range="${k}" aria-pressed="${k === range}">${short}</button>`).join('')}</div>`;
const head = (sub) => `<div class="an-head">${SectionHeader({ title: 'Référencement sur Google', sub, level: 2 })}<div class="an-head__tools">${selector()}</div></div>`;
const dec1 = (v) => (isNum(v) ? v.toFixed(1).replace('.', ',') : null);
const day = (iso) => new Date(`${iso}T00:00:00`).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' });

function kpi(name, k, { format = number, rate = false, basis, note } = {}) {
  const none = !k || !isNum(k.value);
  const delta = !none && isNum(k.previous) ? (rate ? k.value - k.previous : k.previous ? (k.value - k.previous) / k.previous * 100 : null) : null;
  return KpiCard({ label: name, value: none ? null : format(k.value), delta, deltaUnit: rate ? 'points' : 'percent', deltaLabel: 'vs période précédente', deltaReason: 'Pas de période précédente à comparer.', basis, hint: none ? 'Aucune donnée pour cette période.' : note });
}

function table({ id, titre, sub, rows, firstLabel, firstOf, emptyCause }) {
  const head2 = SectionHeader({ title: titre, sub, id: `${id}-h` });
  if (rows === null) return `<section class="card" aria-labelledby="${id}-h">${head2}${EmptyState({ title: 'Section indisponible', cause: 'Google n’a pas répondu pour cette section. Réessayez dans un instant.' })}</section>`;
  if (!rows.length) return `<section class="card" aria-labelledby="${id}-h">${head2}${EmptyState({ title: 'Aucune donnée sur la période', cause: emptyCause })}</section>`;
  return `<section class="card" aria-labelledby="${id}-h">${head2}${DataTable({
    id, rows, pageSize: 10, sort: { key: 'clicks', dir: 'desc' }, caption: titre, csv: { filename: id },
    columns: [
      { key: 'key', label: firstLabel, value: firstOf, render: (r) => `<span class="seo-key" title="${esc(firstOf(r))}">${esc(firstOf(r))}</span>`, sortable: true, wrap: true },
      { key: 'clicks', label: 'Clics', numeric: true, sortable: true, format: number },
      { key: 'impressions', label: 'Impressions', numeric: true, sortable: true, format: number },
      { key: 'ctr', label: 'CTR', numeric: true, sortable: true, format: (v) => (isNum(v) ? pct(v, 1) : null) },
      { key: 'position', label: 'Position', numeric: true, sortable: true, format: dec1 }
    ]
  })}</section>`;
}

function chart(d) {
  const card = (inner) => ({ markup: `<section class="card">${SectionHeader({ title: 'Clics et impressions', level: 2 })}${inner}</section>`, after() {} });
  if (d.series === null) return card(EmptyState({ title: 'Courbe indisponible', cause: 'Google n’a pas fourni la série chronologique.' }));
  if (!d.series.some((p) => p.clicks > 0 || p.impressions > 0)) return card(EmptyState({ title: 'Aucune impression sur la période', cause: 'Le site n’est pas encore apparu dans les résultats Google sur cette période (les données ont 2 à 3 jours de retard), ou la propriété est récente. Essayez une période plus longue.' }));
  const th = Charts.theme(), dates = d.series.map((p) => p.date);
  const series = [
    { label: 'Clics', data: d.series.map((p) => p.clicks), color: th.ink, fill: true },
    { label: 'Impressions', data: d.series.map((p) => p.impressions), color: th.gray, dashed: true, axis: 'y1' }
  ];
  const sum = (k) => d.series.reduce((s, p) => s + p[k], 0);
  return {
    markup: ChartCard({ id: 'seo-line', title: 'Clics et impressions', sub: `${label()} · un point par jour · impressions sur l’axe de droite`, legend: series.map((s) => ({ label: s.label, color: s.color, dash: s.dashed ? '4 4' : '' })),
      summary: `${label()} : ${number(sum('clicks'))} clics et ${number(sum('impressions'))} impressions.`,
      tableFallback: { caption: 'Clics et impressions par jour', columns: ['Date', 'Clics', 'Impressions'], rows: d.series.map((p) => [fmtDay(p.date), number(p.clicks), number(p.impressions)]) } }),
    after() { const c = document.getElementById('seo-line'); if (c) Charts.lines(c, { labels: dates, series }); }
  };
}

function notConfigured(d) {
  const list = (d.missing || []).map((m) => `<li><code>${esc(m)}</code></li>`).join('');
  return `<section class="card" aria-labelledby="seo-nc"><div class="card__head"><div><h2 class="card__title" id="seo-nc">SEO non configuré</h2><span class="card__sub">Les statistiques de référencement viennent de Google Search Console.</span></div>${StatusBadge({ kind: 'neutral', label: 'Non configuré' })}</div>
    <p>Renseignez ces variables d’environnement du service <code>api</code> (Dokploy &gt; Environment), puis redéployez :</p>
    <ul class="an-missing">${list}</ul>
    <p class="muted">Où trouver chaque valeur : <code>.env.example</code>, section « SEO — Google Search Console ». Rien d’autre dans le dashboard n’est affecté.</p></section>`;
}

export async function render(ctx) {
  let d;
  try { d = await Api.getSeo({ range }); } catch (err) {
    if (err && err.code === 'unauthenticated') throw err;
    return { markup: head('') + errorCard(err), after: bind(ctx) };
  }
  if (d.status === 'not_configured') return { markup: notConfigured(d) };
  if (d.status !== 'ok') {
    return { markup: head('') + `<section class="card">${Alert({ kind: 'error', title: 'Search Console indisponible.', html: esc(d.message || 'Les statistiques n’ont pas pu être lues.') })}<p class="muted an-hint">Vérifiez GSC_SITE_URL, GSC_CLIENT_EMAIL et GSC_PRIVATE_KEY dans l’environnement du service api.</p></section>`, after: bind(ctx) };
  }
  const t = d.totals || {}, c = chart(d), p = d.period || {};
  const markup = `${head(`${label()} · du ${day(p.startDate)} au ${day(p.endDate)} (Google publie avec 2 à 3 jours de retard)`)}
    <section class="kpis kpis--4" aria-label="Indicateurs clés">
      ${kpi('Clics', t.clicks, { basis: 'Nombre de fois où un internaute a cliqué sur birostweb.fr dans les résultats Google.' })}
      ${kpi('Impressions', t.impressions, { basis: 'Nombre de fois où le site est apparu dans les résultats Google.' })}
      ${kpi('CTR moyen', t.ctr, { format: (v) => pct(v, 1), rate: true, basis: 'Clics ÷ impressions. Variation en points.' })}
      ${kpi('Position moyenne', t.position, { format: dec1, note: 'Plus le nombre est bas, mieux c’est : une baisse est une amélioration.', basis: 'Position moyenne du site dans les résultats Google : plus le nombre est bas, mieux c’est.' })}
    </section>
    ${c.markup}
    <div class="an-grid">
      ${table({ id: 'seo-queries', titre: 'Requêtes de recherche', sub: `Top 25 · ${label()}`, rows: d.queries, firstLabel: 'Requête', firstOf: (r) => r.query, emptyCause: 'Aucune requête enregistrée (Google masque les requêtes trop rares).' })}
      ${table({ id: 'seo-pages', titre: 'Pages dans Google', sub: `Top 25 · ${label()}`, rows: d.pages, firstLabel: 'Page', firstOf: (r) => r.page.replace(/^https?:\/\/[^/]+/, '') || '/', emptyCause: 'Aucune page enregistrée sur la période.' })}
    </div>`;
  const bound = bind(ctx);
  return { markup, after() { bound(); c.after(); } };
}

function bind(ctx) {
  return () => {
    const box = document.getElementById('seo-range');
    if (!box) return;
    box.addEventListener('click', async (e) => {
      const b = e.target.closest('[data-seo-range]');
      if (!b || b.dataset.seoRange === range) return;
      range = b.dataset.seoRange; store.set('sd.seo.range', range);
      await ctx.rerender();
      const next = document.querySelector(`[data-seo-range="${range}"]`); if (next) next.focus({ preventScroll: true });
    });
  };
}
