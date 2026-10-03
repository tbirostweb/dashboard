/* Réseaux sociaux > Synthèse (#/social) : comparatif des plateformes, graphique comparatif, meilleures publications multi-réseaux. */
import { esc, isNum, number, pct, fmtDateTime, relTime } from '../core/format.js?v=15';
import { PLATFORMS, PLATFORM_LABELS as LABELS, statusLabel, statusKind, viewLabel } from '../core/labels.js?v=15';
import { Tabs, TabPanel, Toolbar, DataTable, Delta, kpiProps, StatusBadge, SectionHeader, EmptyState } from '../ui/components.js?v=15';
import { PLATFORM_ICONS } from '../ui/icons.js?v=15';
import { SOCIAL_TABS } from './tabs.js?v=15';
import { latestSync, available } from './social-shared.js?v=15';
import { compareNetworks, interactionsByNetwork } from './social-charts.js?v=15';
import { PostsTable } from './social-posts.js?v=15';
import { errorCard } from './connections.js?v=15';
import { attentionBadge } from '../core/token-logic.js?v=15';

const Api = window.Api, Charts = window.Charts;
export const title = 'Réseaux sociaux';
export const eyebrow = '';
export const usesToolbar = true;

const rowOf = (p, data, st) => {
  const src = (data.sources || {})[p] || {}, k = (data.kpisByPlatform || {})[p] || {}, per = (data.perPlatform || {})[p] || {};
  const live = available(src), val = (x) => (live && x && isNum(x.value) ? x.value : null);
  return {
    platform: p, status: src.status || (st && st.platforms && st.platforms[p] && st.platforms[p].status) || 'not_connected', live,
    followers: val(k.followers), followersKpi: k.followers, audience: val(per.views), interactions: val(k.interactions), rate: val(k.engagementRate),
    updatedAt: src.updatedAt || null, token: st && st.platforms && st.platforms[p] && st.platforms[p].token
  };
};

export async function render(ctx) {
  const P = ctx.period;
  const [ov, stt] = await Promise.allSettled([Api.getOverview({ period: P }), Api.getStatus()]);
  if (ov.status === 'rejected') {
    if (ov.reason && ov.reason.code === 'unauthenticated') throw ov.reason;
    return { markup: Tabs({ items: SOCIAL_TABS, current: 'synthese', label: 'Réseaux sociaux' }) + TabPanel('synthese', errorCard(ov.reason)) };
  }
  const data = ov.value, st = stt.status === 'fulfilled' ? stt.value : null;
  const rows = PLATFORMS.map((p) => rowOf(p, data, st));
  const nonLive = rows.filter((r) => !r.live);

  const table = DataTable({
    id: 'cmp-table', caption: `Comparaison des réseaux sur ${P} jours`, pageSize: 10,
    columns: [
      { key: 'platform', label: 'Réseau', sortable: false, render: (r) => `<a class="net-link" href="#/social/${esc(r.platform)}">${PLATFORM_ICONS[r.platform]}<span>${esc(LABELS[r.platform])}</span></a>`, text: (r) => LABELS[r.platform] },
      { key: 'status', label: 'Statut', sortable: false, render: (r) => { const tb = attentionBadge(r.token); return `<div class="cell">${StatusBadge({ kind: statusKind(r.status), label: statusLabel(r.status) })}${tb ? `<span class="cell-badge">${StatusBadge(tb)}</span>` : ''}</div>`; }, text: (r) => { const tb = attentionBadge(r.token); return `${statusLabel(r.status)}${tb ? ` — ${tb.label}` : ''}`; } },
      { key: 'followers', label: 'Abonnés', numeric: true, format: number },
      { key: 'delta', label: 'Évolution', numeric: true, value: (r) => (r.followersKpi && isNum(r.followersKpi.delta) ? r.followersKpi.delta : null), render: (r) => (r.live && r.followersKpi ? (() => { const p = kpiProps(r.followersKpi, { period: P }); return Delta({ delta: p.delta, unit: p.deltaUnit, label: '', reason: 'Non comparable' }); })() : '<span aria-hidden="true">—</span><span class="sr-only">non disponible</span>') },
      { key: 'audience', label: 'Portée / vues / impressions', numeric: true, render: (r) => (isNum(r.audience) ? `${number(r.audience)} <span class="muted">${esc(viewLabel(r.platform).toLowerCase())}</span>` : '<span aria-hidden="true">—</span><span class="sr-only">non disponible</span>'), csv: (r) => r.audience },
      { key: 'interactions', label: 'Interactions', numeric: true, format: number },
      { key: 'rate', label: 'Taux', numeric: true, format: (v) => pct(v) },
      { key: 'updatedAt', label: 'Dernière synchro', render: (r) => (r.updatedAt ? `<time datetime="${esc(r.updatedAt)}" title="${esc(fmtDateTime(r.updatedAt))}">${esc(relTime(r.updatedAt))}</time>` : '<span aria-hidden="true">—</span><span class="sr-only">jamais synchronisé</span>'), csv: (r) => r.updatedAt, text: (r) => fmtDateTime(r.updatedAt) },
      { key: 'link', label: 'Détails', sortable: false, render: (r) => `<a class="text-link" href="#/social/${esc(r.platform)}">Ouvrir<span class="sr-only"> ${esc(LABELS[r.platform])}</span></a>`, csv: () => null }
    ],
    rows, sort: { key: 'followers', dir: 'desc' }, csv: { filename: 'comparatif-reseaux' }
  });

  const col = (p) => Charts.theme().platform[p];
  const cmp = compareNetworks(rows.map((r) => ({ platform: r.platform, value: r.interactions })), { id: 'cmp-bars', metric: 'Interactions', title: 'Interactions par réseau (total de la période)', sub: `${P} derniers jours · réseaux disponibles`, colorOf: col });
  const line = interactionsByNetwork(data, { id: 'sy-line', period: P });
  const best = (data.topPosts || []).slice(0, 6);
  const body = `    <section class="card" aria-labelledby="cmp-t">${SectionHeader({ title: 'Comparaison des réseaux', id: 'cmp-t', sub: `${P} derniers jours${nonLive.length ? ` · ${nonLive.length} réseau${nonLive.length > 1 ? 'x' : ''} sans données` : ''}`, actions: '' })}${table}</section>
    <div class="grid grid-2-eq">${cmp.markup}${line.markup}</div>
    <section class="card" aria-labelledby="bp-t">${SectionHeader({ title: 'Meilleures publications', id: 'bp-t', sub: 'Tous réseaux, classées par interactions' })}${best.length ? PostsTable({ id: 'bp-table', platform: '', posts: best, network: true, pageSize: 6, filename: 'meilleures-publications' }) : EmptyState({ title: 'Aucune publication', cause: 'Aucune publication mesurée sur la période.' })}</section>`;
  return {
    markup: Toolbar({ period: P, compare: true, refresh: 'all', updatedAt: latestSync(data.sources) }) + Tabs({ items: SOCIAL_TABS, current: 'synthese', label: 'Réseaux sociaux' }) + TabPanel('synthese', body),
    after() { cmp.after(); line.after(); }
  };
}
