/* Tableau des publications (DataTable : tri, recherche, filtre de type, pagination et export CSV côté client).
   Le lot complet de la période est chargé une seule fois ; trier ne rappelle donc plus /api/posts. */
import { esc, isNum, number, pct, fmtDateTime } from '../core/format.js?v=15';
import { PLATFORM_LABELS as LABELS, likesLabel, sharesLabel, L } from '../core/labels.js?v=15';
import { DataTable, InfoTip } from '../ui/components.js?v=15';
import { postCell, rateText, audienceOf } from './social-shared.js?v=15';

const numCol = (key, label, extra = {}) => ({ key, label, numeric: true, format: number, ...extra });
/** LinkedIn : une publication `measured: false` n'a aucune statistique → « non mesuré » (jamais 0 ni tiret muet). */
const lk = (key, label) => numCol(key, label, { render: (p) => (isNum(p[key]) ? esc(number(p[key])) : p.measured === false ? '<span class="muted">non mesuré</span>' : '<span aria-hidden="true">—</span><span class="sr-only">non disponible</span>') });

/** Colonnes selon la plateforme : l'audience change de nom (portée / vues / impressions), les enregistrements n'existent pas sur LinkedIn. */
export function postColumns(platform, { network = false } = {}) {
  const cols = [{ key: 'title', label: 'Publication', render: (p) => postCell(p), text: (p) => `${p.title || ''} ${p.type || ''}`, wrap: true }];
  if (network) cols.push({ key: 'platform', label: 'Réseau', render: (p) => esc(LABELS[p.platform] || p.platform), format: (v) => LABELS[v] || v });
  cols.push({ key: 'publishedAt', label: 'Date', render: (p) => `<time datetime="${esc(p.publishedAt)}">${esc(fmtDateTime(p.publishedAt))}</time>`, csv: (p) => p.publishedAt, text: (p) => fmtDateTime(p.publishedAt) });
  if (network) cols.push(numCol('audience', 'Audience', { value: audienceOf }));
  else if (platform === 'instagram') cols.push(numCol('reach', 'Portée'), numCol('viewsCount', 'Vues'));
  else if (platform === 'tiktok') cols.push(numCol('views', 'Vues'));
  else cols.push(lk('impressions', 'Impressions'), lk('clicks', 'Clics'));
  if (platform === 'linkedin') cols.push(lk('likes', likesLabel(platform)), lk('comments', 'Commentaires'), lk('shares', sharesLabel(platform)));
  else cols.push(numCol('likes', likesLabel(platform)), numCol('comments', 'Commentaires'), numCol('shares', sharesLabel(platform)));
  if (!network && platform !== 'linkedin') cols.push(numCol('saves', L.saves));
  if (network) cols.push(numCol('interactions', 'Interactions'));
  cols.push({ key: 'engagementRate', label: 'Taux', numeric: true, render: (p) => esc(rateText(p)), csv: (p) => (isNum(p.engagementRate) ? p.engagementRate : null) });
  return cols;
}

/** Titre + infobulle du taux (formule fournie par l'API : `engagementBasis`). */
export const rateTip = (basis) => (basis ? InfoTip({ label: "Définition : taux d'engagement des publications", text: basis }) : '');

export function PostsTable({ id, platform, posts, network = false, pageSize = 15, filename }) {
  return DataTable({
    id, columns: postColumns(platform, { network }), rows: posts, sort: { key: 'publishedAt', dir: 'desc' }, pageSize,
    filters: { search: 'Titre, type, date…', selects: network ? [{ key: 'platform', label: 'Réseau', options: Object.entries(LABELS) }] : [{ key: 'type', label: 'Type' }] },
    csv: { filename: filename || `publications-${platform || 'reseaux'}` },
    caption: network ? 'Meilleures publications, tous réseaux' : `Publications ${LABELS[platform] || ''}`,
    empty: 'Aucune publication ne correspond à ces critères.'
  });
}
export { pct };
