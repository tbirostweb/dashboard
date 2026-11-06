/* Accueil (#/overview) : « est-ce que tout va bien ? » en un écran.
   1. À surveiller (uniquement les problèmes), 2. quatre chiffres clés (site, Google, réseaux).
   Chaque source est lue séparément : l'absence ou la panne de l'une (Umami, Google, un réseau) n'affecte jamais les autres.
   Période fixe : 30 derniers jours (aucun sélecteur ici ; le détail et les périodes sont dans les pages dédiées). */
import { esc, isNum } from '../core/format.js?v=18';
import { KpiCard, kpiProps, StatusBadge, Alert } from '../ui/components.js?v=18';

const Api = window.Api;
export const title = 'Accueil';
export const eyebrow = '';
export const usesToolbar = true; // pas de sélecteur de période ici : période fixe, les pages détaillées ont le leur

const P = 30;
const settled = (r) => (r.status === 'fulfilled' ? r.value : null);
const pctChange = (k) => (k && isNum(k.value) && isNum(k.previous) && k.previous ? (k.value - k.previous) / k.previous * 100 : null);

/** Problèmes à signaler : liste vide = « tout va bien ». */
function alerts({ site, google }) {
  const out = [];
  if (site && site.status === 'error') out.push({ kind: 'warn', text: `Visiteurs : ${site.message || 'Umami indisponible.'}`, href: '#/analytics' });
  if (google && google.status === 'error') out.push({ kind: 'warn', text: `Google : ${google.message || 'Search Console indisponible.'}`, href: '#/seo' });
  return out;
}

const alertsBlock = (list) => (list.length
  ? `<section class="ov-alerts" aria-label="À surveiller">${list.map((a) => Alert({ kind: a.kind, html: esc(a.text), actions: `<a class="text-link" href="${esc(a.href)}">Voir</a>` })).join('')}</section>`
  : `<p class="ov-ok">${StatusBadge({ kind: 'ok', label: 'Tout va bien' })}<span class="muted">Aucun problème détecté sur le site et les statistiques.</span></p>`);

function kpiFrom(label, source, key, { href, unconfigured, format } = {}) {
  if (!source) return KpiCard({ label, value: null, hint: 'Données indisponibles.' });
  if (source.status === 'not_configured') return KpiCard({ label, value: null, hint: unconfigured });
  if (source.status === 'error') return KpiCard({ label, value: null, hint: 'Indisponible pour le moment.' });
  const k = (source.totals || {})[key] || {};
  return KpiCard({ label, value: isNum(k.value) ? (format ? format(k.value) : k.value) : null, delta: pctChange(k), deltaLabel: 'vs période précédente', deltaReason: 'Pas de période précédente à comparer.', hint: undefined });
}

export async function render() {
  const [siteR, googleR, socialR] = await Promise.allSettled([
    Api.getAnalytics({ range: '30d' }), Api.getSeo({ range: '30d' }), Api.getOverview({ period: P })
  ]);
  for (const r of [siteR, googleR, socialR]) if (r.status === 'rejected' && r.reason && r.reason.code === 'unauthenticated') throw r.reason;
  const site = settled(siteR), google = settled(googleR), social = settled(socialR);
  const t = (social && social.totals) || {};
  const sk = (k, rate) => (k ? kpiProps(k, { period: P, rate }) : { delta: null, deltaReason: 'Donnée indisponible.' });
  const kpis = `<section class="kpis kpis--4" aria-label="Indicateurs clés">
    ${kpiFrom(`Visiteurs (${P} j)`, site, 'visitors', { unconfigured: 'Umami n’est pas configuré (onglet Site web).' })}
    ${kpiFrom(`Clics Google (${P} j)`, google, 'clicks', { unconfigured: 'Search Console n’est pas configuré (onglet Site web).' })}
    ${KpiCard({ label: 'Abonnés totaux', value: t.followers && isNum(t.followers.value) ? t.followers.value : null, ...sk(t.followers), hint: !social ? 'Réseaux indisponibles.' : t.followers && !isNum(t.followers.value) ? t.followers.reason : undefined })}
    ${KpiCard({ label: `Interactions (${P} j)`, value: t.interactions && isNum(t.interactions.value) ? t.interactions.value : null, ...sk(t.interactions), hint: !social ? 'Réseaux indisponibles.' : t.interactions && !isNum(t.interactions.value) ? t.interactions.reason : undefined })}
  </section>`;
  const markup = `${alertsBlock(alerts({ site, google }))}${kpis}`;
  return { markup };
}
