/* Section « Site web » : onglets Visiteurs (Umami) / Google (Search Console) et période commune (7 j, 30 j, 12 mois),
   mémorisée d'un onglet à l'autre. */
import { esc } from '../core/format.js?v=17';
import { Tabs, TabPanel } from '../ui/components.js?v=17';
import { store } from '../core/state.js?v=17';

export const SITE_TABS = [
  { id: 'visitors', label: 'Visiteurs', href: '#/analytics' },
  { id: 'google', label: 'Google', href: '#/seo' }
];
export const SITE_RANGES = [['7d', '7 j', '7 derniers jours'], ['30d', '30 j', '30 derniers jours'], ['12m', '12 mois', '12 derniers mois']];
const KEY = 'sd.site.range';

let range = (() => { const r = store.get(KEY); return SITE_RANGES.some(([k]) => k === r) ? r : '30d'; })();
export const getRange = () => range;
export const rangeLabel = () => SITE_RANGES.find(([k]) => k === range)[2];
export function setRange(r) { if (SITE_RANGES.some(([k]) => k === r)) { range = r; store.set(KEY, r); } }

/** Sélecteur de période (même balisage sur les deux onglets). */
export const rangeSelector = () => `<div class="seg an-range" id="site-range" role="group" aria-label="Période des statistiques">${SITE_RANGES.map(([k, short]) => `<button type="button" data-site-range="${k}" aria-pressed="${k === range}">${esc(short)}</button>`).join('')}</div>`;
export const siteHeader = (current) => Tabs({ items: SITE_TABS, current, label: 'Site web' });
export const sitePanel = (current, html) => TabPanel(current, html);

/** Relie le sélecteur : change la période, relance le rendu et rend le focus au bouton choisi. */
export function bindRange(ctx) {
  const box = document.getElementById('site-range');
  if (!box) return;
  box.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-site-range]');
    if (!b || b.dataset.siteRange === range) return;
    setRange(b.dataset.siteRange);
    await ctx.rerender();
    const next = document.querySelector(`[data-site-range="${range}"]`); if (next) next.focus({ preventScroll: true });
  });
}
