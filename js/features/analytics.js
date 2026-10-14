/* Analytics (#/analytics) : fréquentation de birostweb.fr via Umami (lecture seule, appels faits par le backend : GET /api/analytics?range=7d|30d|12m).
   États : non configuré (variables d'environnement manquantes), erreur Umami, ou rapport (KPI avec variation, courbe, sources, pages). */
import { esc, isNum, number, pct, fmtDay, regionName } from '../core/format.js?v=17';
import { KpiCard, EmptyState, SectionHeader, ChartCard, StatusBadge, Alert, Fold } from '../ui/components.js?v=17';
import { siteHeader, sitePanel, rangeSelector, rangeLabel as label, getRange, bindRange } from './site-shared.js?v=17';
import { errorCard } from './connections.js?v=17';
import { rerenderSilent } from '../core/router.js?v=17';

const Api = window.Api, Charts = window.Charts;
export const title = 'Site web';
export const eyebrow = '';
export const usesToolbar = true; // sélecteur de période propre à la page (7 j / 30 j / 12 mois) : celui de l'en-tête est masqué

/** Durée en secondes → « m:ss » (mm:ss), ou « h:mm:ss » au-delà d'une heure. */
export function mmss(sec) {
  if (!isNum(sec)) return null;
  const s = Math.round(sec), h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), r = s % 60;
  const two = (n) => String(n).padStart(2, '0');
  return h ? `${h}:${two(m)}:${two(r)}` : `${two(m)}:${two(r)}`;
}

const DEVICES = { desktop: 'Ordinateur', laptop: 'Ordinateur portable', mobile: 'Mobile', tablet: 'Tablette' };
const wrap = (html) => siteHeader('visitors') + sitePanel('visitors', html);
const head = (sub, extra = '') => `<div class="an-head">${SectionHeader({ title: 'Fréquentation de birostweb.fr', sub, level: 2 })}<div class="an-head__tools">${extra}${rangeSelector()}</div></div>`;

/** Variation vs période précédente : en % (valeurs), en points (taux). Précédent absent ou nul → raison brève. */
function kpi(name, k, { format = number, rate = false, basis } = {}) {
  const none = !k || !isNum(k.value);
  const delta = !none && isNum(k.previous) ? (rate ? k.value - k.previous : k.previous ? (k.value - k.previous) / k.previous * 100 : null) : null;
  return KpiCard({ label: name, value: none ? null : format(k.value), delta, deltaUnit: rate ? 'points' : 'percent', deltaLabel: 'vs période précédente', deltaReason: 'Pas de période précédente à comparer.', basis, hint: none ? 'Donnée non fournie par Umami.' : undefined });
}

/** Classement horizontal (barres CSS, valeurs en toutes lettres : la barre ne porte jamais seule l'information).
 *  5 lignes visibles, le reste dans « Voir les N suivants » ; bare = sans carte (inclus dans un bloc repliable). */
const TOP = 5;
function ranking({ id, titre, sub, rows, emptyCause, labelOf, bare = false }) {
  const open = bare ? `<div class="rank-block" aria-labelledby="${id}">` : `<section class="card" aria-labelledby="${id}">`;
  const close = bare ? '</div>' : '</section>';
  const head2 = bare ? `<h3 class="rank-block__title" id="${id}">${esc(titre)}</h3>` : SectionHeader({ title: titre, id, sub });
  if (rows === null) return `${open}${head2}${EmptyState({ title: 'Section indisponible', cause: 'Umami n’a pas répondu pour cette section. Réessayez dans un instant.' })}${close}`;
  if (!rows.length) return `${open}${head2}${EmptyState({ title: 'Aucune donnée sur la période', cause: emptyCause })}${close}`;
  const max = Math.max(...rows.map((r) => r.value), 1), total = rows.reduce((s, r) => s + r.value, 0);
  const item = (r) => `<li class="rank__item"><span class="rank__label" title="${esc(labelOf(r.label))}">${esc(labelOf(r.label))}</span><span class="rank__value">${number(r.value)}<small>${pct(total ? r.value / total * 100 : 0, 0)}</small></span><span class="rank__bar" aria-hidden="true"><i style="width:${Math.max(2, r.value / max * 100).toFixed(1)}%"></i></span></li>`;
  const more = rows.slice(TOP);
  return `${open}${head2}<ol class="rank">${rows.slice(0, TOP).map(item).join('')}</ol>${more.length ? `<details class="rank-more"><summary>Voir les ${more.length} suivants</summary><ol class="rank">${more.map(item).join('')}</ol></details>` : ''}${close}`;
}

function visitsChart(d) {
  const pts = d.series || [], sess = d.visitorsSeries || [];
  if (d.series === null) return { markup: `<section class="card">${SectionHeader({ title: 'Évolution des visites', level: 2 })}${EmptyState({ title: 'Courbe indisponible', cause: 'Umami n’a pas fourni la série chronologique.' })}</section>`, after() {} };
  if (!pts.length || !pts.some((p) => p.value > 0)) return { markup: `<section class="card">${SectionHeader({ title: 'Évolution des visites', level: 2 })}${EmptyState({ title: 'Aucune visite sur la période', cause: 'Vérifiez que le script de suivi est bien installé sur le site, puis essayez une période plus longue.' })}</section>`, after() {} };
  const dates = pts.map((p) => p.date), byDate = new Map(sess.map((p) => [p.date, p.value]));
  const th = Charts.theme();
  const series = [{ label: 'Pages vues', data: pts.map((p) => p.value), color: th.ink, fill: true }];
  if (sess.length) series.push({ label: 'Visiteurs', data: dates.map((x) => (byDate.has(x) ? byDate.get(x) : null)), color: th.gray, dashed: true });
  const unit = d.unit === 'month' ? 'mois' : 'jour';
  const sum = (a) => a.reduce((s, p) => s + p.value, 0);
  const summary = `${label()} : ${number(sum(pts))} pages vues${sess.length ? ` et ${number(sum(sess))} visiteurs` : ''}, un point par ${unit}.`;
  return {
    markup: ChartCard({ id: 'an-line', title: 'Évolution des visites', sub: `${label()} · un point par ${unit}`, legend: series.map((s) => ({ label: s.label, color: s.color, dash: s.dashed ? '4 4' : '' })), summary,
      tableFallback: { caption: 'Pages vues et visiteurs par ' + unit, columns: ['Date', ...series.map((s) => s.label)], rows: dates.map((x, i) => [fmtDay(x), ...series.map((s) => (isNum(s.data[i]) ? number(s.data[i]) : 'n.d.'))]) } }),
    after() { const c = document.getElementById('an-line'); if (c) Charts.lines(c, { labels: dates, series }); }
  };
}

function notConfigured(d) {
  const list = (d.missing || []).map((m) => `<li><code>${esc(m)}</code></li>`).join('');
  return `<section class="card" aria-labelledby="an-nc"><div class="card__head"><div><h2 class="card__title" id="an-nc">Visiteurs non configurés</h2><span class="card__sub">Les statistiques de fréquentation viennent d’Umami.</span></div>${StatusBadge({ kind: 'neutral', label: 'Non configuré' })}</div>
    <p>Renseignez ces variables d’environnement du service <code>api</code> (Dokploy &gt; Environment), puis redéployez :</p>
    <ul class="an-missing">${list}</ul>
    <p class="muted">Modèle et explications : <code>.env.example</code>, section « Analytics — Umami ». Rien d’autre dans le dashboard n’est affecté.</p></section>`;
}

export async function render(ctx) {
  let d;
  try { d = await Api.getAnalytics({ range: getRange() }); } catch (err) {
    if (err && err.code === 'unauthenticated') throw err;
    return { markup: wrap(head('') + errorCard(err)), after: () => bindRange(ctx) };
  }
  if (d.status === 'not_configured') return { markup: wrap(notConfigured(d)) };
  if (d.status !== 'ok') {
    return { markup: wrap(head('') + `<section class="card">${Alert({ kind: 'error', title: 'Umami indisponible.', html: esc(d.message || 'Les statistiques n’ont pas pu être lues.') })}<p class="muted an-hint">Vérifiez UMAMI_BASE_URL, UMAMI_WEBSITE_ID et les identifiants dans l’environnement du service api.</p></section>`), after: () => bindRange(ctx) };
  }
  const t = d.totals || {};
  const live = isNum(d.active) ? `<span class="an-live">${StatusBadge({ kind: d.active ? 'ok' : 'neutral', label: `${number(d.active)} visiteur${d.active > 1 ? 's' : ''} en direct` })}</span>` : '';
  const chart = visitsChart(d);
  const markup = wrap(`${head(`${label()} · mis à jour à ${new Date(d.updatedAt).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })}`, live)}
    <section class="kpis kpis--5" aria-label="Indicateurs clés">
      ${kpi('Visiteurs uniques', t.visitors, { basis: 'Nombre de visiteurs distincts sur la période (identifiés sans cookie par Umami).' })}
      ${kpi('Visites', t.visits, { basis: 'Une visite = une session de navigation d’un visiteur.' })}
      ${kpi('Pages vues', t.pageviews)}
      ${kpi('Temps moyen par visite', t.avgVisitSeconds, { format: mmss, basis: 'Temps total passé sur le site ÷ nombre de visites (mm:ss).' })}
      ${kpi('Taux de rebond', t.bounceRate, { format: (v) => pct(v, 1), rate: true, basis: 'Visites d’une seule page ÷ visites. Variation en points.' })}
    </section>
    ${chart.markup}
    <div class="an-grid">
      ${ranking({ id: 'an-ref', titre: 'D’où viennent les visiteurs', sub: label(), rows: d.referrers, emptyCause: 'Aucun référent enregistré (les accès directs sont regroupés sous « Direct »).', labelOf: (x) => x || 'Direct / inconnu' })}
      ${ranking({ id: 'an-pages', titre: 'Pages les plus vues', sub: label(), rows: d.pages, emptyCause: 'Aucune page vue enregistrée.', labelOf: (x) => x || '/' })}
    </div>
    ${Fold({ id: 'an-more', title: 'Pays et appareils', sub: 'Détail de l’audience', body: `<div class="an-grid an-grid--flat">
      ${ranking({ bare: true, id: 'an-country', titre: 'Pays', sub: `Top 10 · ${label()}`, rows: d.countries, emptyCause: 'Aucun pays enregistré (la géolocalisation dépend de la base GeoIP d’Umami).', labelOf: (x) => (x ? regionName(String(x).toUpperCase()) : 'Inconnu') })}
      ${ranking({ bare: true, id: 'an-device', titre: 'Appareils', sub: `Type d’appareil · ${label()}`, rows: d.devices, emptyCause: 'Aucun appareil enregistré.', labelOf: (x) => DEVICES[String(x).toLowerCase()] || x || 'Inconnu' })}
    </div>` })}`);
  return { markup, after() { bindRange(ctx); chart.after(); autoRefresh(); } };
}

/** Rafraîchissement automatique (60 s) tant que l'onglet Analytics est affiché et visible : relecture sans cache puis rendu silencieux. */
let timer = null;
function autoRefresh() {
  clearInterval(timer);
  timer = setInterval(async () => {
    if (location.hash !== '#/analytics') { clearInterval(timer); timer = null; return; }
    if (document.visibilityState !== 'visible') return;
    try { await Api.refreshAnalytics({ range: getRange() }); await rerenderSilent(); } catch (e) { /* la page reste telle quelle */ }
  }, 60000);
}
