/* Accueil (#/overview) : « est-ce que tout va bien ? » en un écran.
   1. À surveiller (uniquement les problèmes), 2. quatre chiffres clés (site, Google, réseaux), 3. état de chaque VPS, 4. dernière activité.
   Chaque source est lue séparément : l'absence ou la panne de l'une (Umami, Google, un VPS, un réseau) n'affecte jamais les autres.
   Période fixe : 30 derniers jours (aucun sélecteur ici ; le détail et les périodes sont dans les pages dédiées). */
import { esc, isNum, number, pct, fmtDateTime, relTime } from '../core/format.js?v=17';
import { MON_LABEL, statusLabel, statusKind } from '../core/labels.js?v=17';
import { KpiCard, kpiProps, StatusBadge, Meter, EmptyState, SectionHeader, Alert } from '../ui/components.js?v=17';

const Api = window.Api;
export const title = 'Accueil';
export const eyebrow = '';
export const usesToolbar = true; // pas de sélecteur de période ici : période fixe, les pages détaillées ont le leur

const DAY = 86400000, P = 30;
const ratio = (used, total) => (isNum(used) && isNum(total) && total > 0 ? used / total * 100 : null);
const gib = (b) => (isNum(b) ? `${(b / 1024 ** 3).toFixed(1).replace('.', ',')} Gio` : null);
const settled = (r) => (r.status === 'fulfilled' ? r.value : null);
const isDown = (s) => !s || s.status === 'error' || s.status === 'not_configured';
const pctChange = (k) => (k && isNum(k.value) && isNum(k.previous) && k.previous ? (k.value - k.previous) / k.previous * 100 : null);

/** Problèmes à signaler : liste vide = « tout va bien ». */
function alerts({ servers, site, google }) {
  const out = [];
  for (const s of servers) {
    if (s.status === 'error') { out.push({ kind: 'error', text: `${s.name} : ${(s.connection && s.connection.message) || (s.notes && s.notes[0]) || 'Dokploy injoignable.'}`, href: '#/infrastructure', id: s.id }); continue; }
    if (s.status === 'not_configured') continue;
    const failed = (s.deployments || []).filter((d) => Date.parse(d.createdAt) >= Date.now() - DAY && d.status === 'error').length;
    if (failed) out.push({ kind: 'warn', text: `${s.name} : ${failed} déploiement${failed > 1 ? 's' : ''} en échec sur 24 h.`, href: '#/infrastructure', id: s.id });
    const m = s.server && s.server.status === 'available' ? s.server : null;
    if (m) for (const [label, v] of [['CPU', m.cpuPercent], ['Mémoire', ratio(m.ramUsedBytes, m.ramTotalBytes)], ['Stockage', ratio(m.storageUsedBytes, m.storageTotalBytes)]]) {
      if (isNum(v) && v >= 90) out.push({ kind: 'warn', text: `${s.name} : ${label} à ${Math.round(v)} %.`, href: '#/infrastructure', id: s.id });
    }
  }
  if (site && site.status === 'error') out.push({ kind: 'warn', text: `Visiteurs : ${site.message || 'Umami indisponible.'}`, href: '#/analytics' });
  if (google && google.status === 'error') out.push({ kind: 'warn', text: `Google : ${google.message || 'Search Console indisponible.'}`, href: '#/seo' });
  return out;
}

const alertsBlock = (list) => (list.length
  ? `<section class="ov-alerts" aria-label="À surveiller">${list.map((a) => Alert({ kind: a.kind, html: esc(a.text), actions: `<a class="text-link" href="${esc(a.href)}">Voir</a>` })).join('')}</section>`
  : `<p class="ov-ok">${StatusBadge({ kind: 'ok', label: 'Tout va bien' })}<span class="muted">Aucun problème détecté sur les serveurs, le site et les statistiques.</span></p>`);

function kpiFrom(label, source, key, { href, unconfigured, format } = {}) {
  if (!source) return KpiCard({ label, value: null, hint: 'Données indisponibles.' });
  if (source.status === 'not_configured') return KpiCard({ label, value: null, hint: unconfigured });
  if (source.status === 'error') return KpiCard({ label, value: null, hint: 'Indisponible pour le moment.' });
  const k = (source.totals || {})[key] || {};
  return KpiCard({ label, value: isNum(k.value) ? (format ? format(k.value) : k.value) : null, delta: pctChange(k), deltaLabel: 'vs période précédente', deltaReason: 'Pas de période précédente à comparer.', hint: undefined });
}

function serverCard(s) {
  const head = `<div class="vps__head"><h3 class="vps__name">${esc(s.name)}</h3>${s.status === 'not_configured' ? StatusBadge({ kind: 'neutral', label: 'Non configuré' }) : s.status === 'error' ? StatusBadge({ kind: 'error', label: 'Injoignable' }) : StatusBadge({ kind: statusKind(s.server && s.server.status), label: MON_LABEL[(s.server && s.server.status) || 'unknown'] || 'État indéterminé' })}</div>`;
  if (isDown(s)) return `<div class="vps">${head}<p class="muted">${esc(s.status === 'not_configured' ? 'Dokploy n’est pas configuré pour ce serveur.' : (s.connection && s.connection.message) || (s.notes && s.notes[0]) || 'Dokploy est injoignable.')}</p></div>`;
  const m = s.server && s.server.status === 'available' ? s.server : {};
  const services = s.services || [], online = services.filter((x) => ['done', 'healthy', 'active'].includes(x.status)).length;
  return `<div class="vps">${head}
    <div class="meters">${Meter({ label: 'CPU', percent: m.cpuPercent })}
      ${Meter({ label: 'Mémoire', percent: ratio(m.ramUsedBytes, m.ramTotalBytes), detail: isNum(m.ramUsedBytes) && isNum(m.ramTotalBytes) ? `${gib(m.ramUsedBytes)} sur ${gib(m.ramTotalBytes)}` : undefined })}
      ${Meter({ label: 'Stockage', percent: ratio(m.storageUsedBytes, m.storageTotalBytes), detail: isNum(m.storageUsedBytes) && isNum(m.storageTotalBytes) ? `${gib(m.storageUsedBytes)} sur ${gib(m.storageTotalBytes)}` : undefined })}</div>
    ${s.server && s.server.status !== 'available' && s.server.message ? `<p class="muted">${esc(s.server.message)}</p>` : ''}
    <p class="vps__foot muted">${services.length ? `${online} service${online > 1 ? 's' : ''} en ligne sur ${services.length}` : 'Aucun service lu'}</p></div>`;
}

function activity(servers) {
  const rows = servers.filter((s) => !isDown(s)).flatMap((s) => (s.deployments || []).map((d) => ({ ...d, vps: s.name, multi: servers.length > 1 })))
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))).slice(0, 4);
  if (!rows.length) return EmptyState({ title: 'Aucune activité', cause: 'Aucun déploiement récent n’a pu être lu.' });
  return `<ul class="activity">${rows.map((d) => `<li class="activity__item"><div class="activity__main"><span class="activity__ctx">${esc(d.context || d.serviceName || 'Service inconnu')}${d.multi ? ` <span class="muted">· ${esc(d.vps)}</span>` : ''}</span><span class="muted">${d.createdAt ? `<time datetime="${esc(d.createdAt)}" title="${esc(fmtDateTime(d.createdAt))}">${esc(relTime(d.createdAt))}</time>` : 'Date indisponible'}</span></div>${StatusBadge({ kind: statusKind(d.status), label: statusLabel(d.status) })}</li>`).join('')}</ul>`;
}

export async function render() {
  const [infraR, siteR, googleR, socialR] = await Promise.allSettled([
    Api.getInfrastructureAll(), Api.getAnalytics({ range: '30d' }), Api.getSeo({ range: '30d' }), Api.getOverview({ period: P })
  ]);
  for (const r of [infraR, siteR, googleR, socialR]) if (r.status === 'rejected' && r.reason && r.reason.code === 'unauthenticated') throw r.reason;
  const servers = (settled(infraR) || {}).servers || [], site = settled(siteR), google = settled(googleR), social = settled(socialR);
  const t = (social && social.totals) || {};
  const sk = (k, rate) => (k ? kpiProps(k, { period: P, rate }) : { delta: null, deltaReason: 'Donnée indisponible.' });
  const kpis = `<section class="kpis kpis--4" aria-label="Indicateurs clés">
    ${kpiFrom(`Visiteurs (${P} j)`, site, 'visitors', { unconfigured: 'Umami n’est pas configuré (onglet Site web).' })}
    ${kpiFrom(`Clics Google (${P} j)`, google, 'clicks', { unconfigured: 'Search Console n’est pas configuré (onglet Site web).' })}
    ${KpiCard({ label: 'Abonnés totaux', value: t.followers && isNum(t.followers.value) ? t.followers.value : null, ...sk(t.followers), hint: !social ? 'Réseaux indisponibles.' : t.followers && !isNum(t.followers.value) ? t.followers.reason : undefined })}
    ${KpiCard({ label: `Interactions (${P} j)`, value: t.interactions && isNum(t.interactions.value) ? t.interactions.value : null, ...sk(t.interactions), hint: !social ? 'Réseaux indisponibles.' : t.interactions && !isNum(t.interactions.value) ? t.interactions.reason : undefined })}
  </section>`;
  const serversCard = `<section class="card" aria-labelledby="ov-srv">${SectionHeader({ title: 'Serveurs', id: 'ov-srv', actions: '<a class="text-link" href="#/infrastructure">Détails</a>' })}
    ${servers.length ? `<div class="vps-grid">${servers.map(serverCard).join('')}</div>` : EmptyState({ title: 'Serveurs indisponibles', cause: 'Dokploy n’a pas pu être lu.' })}</section>`;
  const markup = `${alertsBlock(alerts({ servers, site, google }))}${kpis}
    ${serversCard}
    <section class="card" aria-labelledby="ov-act">${SectionHeader({ title: 'Dernière activité', id: 'ov-act', sub: 'Derniers déploiements', actions: '<a class="text-link" href="#/infrastructure">Serveurs</a>' })}${activity(servers)}</section>`;
  return { markup };
}
