/* Graphiques inter-réseaux (Vue d'ensemble, Synthèse). Garde-fous : aucune donnée → EmptyState explicite, jamais un graphique vide. */
import { esc, isNum, number, pct, fmtDay } from '../core/format.js?v=15';
import { PLATFORMS, PLATFORM_LABELS as LABELS, INTERACTIONS_DEF } from '../core/labels.js?v=15';
import { ChartCard, EmptyState, seriesTable, Legend } from '../ui/components.js?v=15';
import { available, hasSignal, sumKnown, legendOf } from './social-shared.js?v=15';

const Charts = window.Charts;

/**
 * « Interactions par réseau » : une courbe par réseau disponible (couleur + motif de trait + légende directe).
 * Les interactions sont rattachées au jour de publication ; les jours sans publication n'ont pas de mesure (points isolés, non reliés à zéro).
 * Retourne { markup, after }.
 */
export function interactionsByNetwork(data, { id = 'ov-line', period }) {
  const nets = PLATFORMS.filter((p) => available((data.sources || {})[p]));
  const dates = (data.series && data.series.dates) || [];
  const live = nets.filter((p) => hasSignal(data.series && data.series.interactions && data.series.interactions[p]));
  const title = 'Interactions par réseau';
  const card = (inner) => `<section class="card" aria-labelledby="${id}-t"><div class="card__head"><div><h2 class="card__title" id="${id}-t">${title}</h2><span class="card__sub">${period} derniers jours</span></div></div>${inner}</section>`;
  if (!nets.length) {
    return { markup: card(EmptyState({ title: 'Aucun réseau connecté', cause: 'Reliez Instagram ou TikTok dans les Paramètres pour afficher les interactions.', action: { label: 'Ouvrir les Paramètres', href: '#/settings' } })), after() {} };
  }
  if (!live.length) {
    return { markup: card(EmptyState({ title: 'Aucune interaction sur la période', cause: `Les publications des ${period} derniers jours n'ont reçu aucune interaction connue, ou aucune publication n'a été mesurée. Essayez une période plus longue.` })), after() {} };
  }
  const series = live.map((p) => ({ label: LABELS[p], data: data.series.interactions[p], platform: p, connect: true }));
  const totals = live.map((p) => `${LABELS[p]} ${number(sumKnown(data.series.interactions[p]))}`);
  const withData = dates.map((d, i) => i).filter((i) => series.some((s) => isNum(s.data[i])));
  const summary = `Interactions sur ${period} jours, rattachées au jour de publication : ${totals.join(', ')}. ${withData.length} jour${withData.length > 1 ? 's' : ''} avec publication mesurée.`;
  const table = seriesTable({ labels: withData.map((i) => dates[i]), series: series.map((s) => ({ label: s.label, data: withData.map((i) => s.data[i]) })), caption: 'Interactions par réseau et par jour de publication' });
  return {
    markup: ChartCard({ id, title, sub: `${period} derniers jours · chaque point = un jour avec publication`, legend: live.map((p) => ({ key: p, label: LABELS[p] })), info: INTERACTIONS_DEF, summary, tableFallback: table }),
    after() { const c = document.getElementById(id); if (c) Charts.lines(c, { labels: dates, series }); }
  };
}

/** Comparatif de plateformes (barres horizontales, une barre par réseau, libellé direct). */
export function compareNetworks(rows, { id = 'cmp-bars', metric, title, sub, format = number, colorOf }) {
  const known = rows.filter((r) => isNum(r.value));
  if (!known.length) return { markup: `<section class="card" aria-labelledby="${id}-t"><h2 class="card__title" id="${id}-t">${esc(title)}</h2>${EmptyState({ title: 'Aucune donnée à comparer', cause: 'Aucun réseau ne fournit cette mesure sur la période.' })}</section>`, after() {} };
  const summary = `${title} : ${known.map((r) => `${LABELS[r.platform]} ${format(r.value)}`).join(', ')}${rows.length > known.length ? `. Non disponible : ${rows.filter((r) => !isNum(r.value)).map((r) => LABELS[r.platform]).join(', ')}` : ''}.`;
  return {
    markup: ChartCard({ id, title, sub, height: 'mini', summary, tableFallback: { caption: title, columns: ['Réseau', metric], rows: rows.map((r) => [LABELS[r.platform], isNum(r.value) ? format(r.value) : 'Indisponible']) } }),
    after() {
      const c = document.getElementById(id); if (!c) return;
      Charts.bars(c, { labels: known.map((r) => LABELS[r.platform]), horizontal: true, series: [{ label: metric, data: known.map((r) => r.value), colors: known.map((r) => colorOf(r.platform)) }], yFormat: (v) => format(v), tooltipFormat: format });
    }
  };
}
export { Legend, legendOf, pct, fmtDay };
