/* Serveurs (#/infrastructure) : les DEUX VPS côte à côte, chacun avec ses mesures (CPU, mémoire, stockage), son état de connexion et ses services
   (Redéployer / Recharger, lien Dokploy). Chaque VPS est lu séparément (GET /api/infrastructure/all) : la panne de l'un n'affecte pas l'autre.
   Actualisation automatique toutes les 30 s (Dokploy échantillonne ses mesures environ chaque minute). */
import { esc, isNum, number, relTime, fmtDateTime } from '../core/format.js?v=17';
import { MON_LABEL, statusKind } from '../core/labels.js?v=17';
import { StatusBadge, Meter, EmptyState, SectionHeader } from '../ui/components.js?v=17';
import { rerenderSilent } from '../core/router.js?v=17';
import { serviceBadge, serviceActions, ctxOf, connLabel, measuredText } from './infra-shared.js?v=17';

const Api = window.Api;
export const title = 'Serveurs';
export const eyebrow = '';
export const usesToolbar = true; // pas de sélecteur de période ici

const ratio = (used, total) => (isNum(used) && isNum(total) && total > 0 ? used / total * 100 : null);
const gio = (b) => (isNum(b) ? `${(b / 1024 ** 3).toFixed(1).replace('.', ',')} Gio` : null);
const connKind = (s) => (s.status === 'connected' ? 'ok' : s.status === 'not_configured' ? 'neutral' : 'error');

function measures(s) {
  const srv = s.server || {}, m = srv.status === 'available' ? srv : {};
  const note = srv.status === 'available' ? `<p class="muted vps__when">${esc(measuredText(srv))}${srv.source === 'dokploy_agent' ? ' · agent de monitoring Dokploy' : srv.source === 'dokploy_native' ? ' · monitoring natif Dokploy' : ''}</p>`
    : `<p class="vps__note">${StatusBadge({ kind: statusKind(srv.status), label: MON_LABEL[srv.status] || 'État indéterminé' })}<span class="muted">${esc(srv.message || 'Mesures indisponibles.')}</span></p>`;
  return `<div class="meters">
      ${Meter({ label: 'CPU', percent: m.cpuPercent })}
      ${Meter({ label: 'Mémoire (RAM)', percent: ratio(m.ramUsedBytes, m.ramTotalBytes), detail: isNum(m.ramUsedBytes) && isNum(m.ramTotalBytes) ? `${gio(m.ramUsedBytes)} sur ${gio(m.ramTotalBytes)}` : undefined })}
      ${Meter({ label: 'Stockage', percent: ratio(m.storageUsedBytes, m.storageTotalBytes), detail: isNum(m.storageUsedBytes) && isNum(m.storageTotalBytes) ? `${gio(m.storageUsedBytes)} sur ${gio(m.storageTotalBytes)}` : undefined })}
    </div>${note}`;
}

function serviceRow(s, caps) {
  const last = s.lastDeployment;
  return `<li class="svc">
    <div class="svc__main"><strong class="svc__name">${esc(s.name || 'Service inconnu')}</strong><span class="muted svc__ctx">${esc(ctxOf(s))}</span>
      <span class="muted">${last && last.createdAt ? `Dernier déploiement <time datetime="${esc(last.createdAt)}" title="${esc(fmtDateTime(last.createdAt))}">${esc(relTime(last.createdAt))}</time>` : 'Aucun déploiement lu'}</span></div>
    <div class="svc__side">${serviceBadge(s.status)}${serviceActions(s, caps)}</div></li>`;
}

function serverColumn(s) {
  const services = (s.services || []).map((x) => ({ ...x, vpsId: s.id }));
  const online = services.filter((x) => ['done', 'healthy', 'active'].includes(x.status)).length;
  const head = `<div class="vps__head"><div><h2 class="card__title" id="vps-${esc(s.id)}">${esc(s.name)}</h2>${s.version ? `<span class="card__sub">Dokploy ${esc(s.version)}</span>` : ''}</div>${StatusBadge({ kind: connKind(s), label: s.status === 'not_configured' ? 'Non configuré' : connLabel(s) })}</div>`;
  if (s.status !== 'connected') {
    const why = s.status === 'not_configured' ? 'Dokploy n’est pas configuré pour ce serveur (variables DOKPLOY…).' : (s.connection && s.connection.message) || (s.notes && s.notes[0]) || 'Dokploy est injoignable.';
    return `<section class="card vps-col" aria-labelledby="vps-${esc(s.id)}">${head}${EmptyState({ title: 'Serveur indisponible', cause: why })}</section>`;
  }
  return `<section class="card vps-col" aria-labelledby="vps-${esc(s.id)}">${head}${measures(s)}
    <div class="vps__svc-head"><h3 class="vps__sub">Services</h3><span class="muted">${services.length ? `${number(online)} en ligne sur ${number(services.length)}` : 'Aucun service'}</span></div>
    ${services.length ? `<ul class="svc-list">${services.map((x) => serviceRow(x, s.capabilities)).join('')}</ul>` : EmptyState({ title: 'Aucun service accessible', cause: 'Vérifiez les permissions de la clé API de ce serveur.' })}</section>`;
}

let timer = null;
function autoRefresh() {
  clearInterval(timer);
  timer = setInterval(async () => {
    if (location.hash !== '#/infrastructure') { clearInterval(timer); timer = null; return; }
    if (document.visibilityState !== 'visible') return;
    try { await Api.refreshInfrastructureAll(); await rerenderSilent(); } catch (e) { /* la page reste telle quelle */ }
  }, 30000);
}

export async function render() {
  let servers;
  try { servers = ((await Api.getInfrastructureAll()) || {}).servers || []; } catch (err) {
    if (err && err.code === 'unauthenticated') throw err;
    return { markup: `<section class="card">${EmptyState({ title: 'Serveurs indisponibles', cause: (err && err.message) || 'Le dashboard n’a pas pu lire les serveurs.', action: { label: 'Réessayer', data: 'data-infra-retry' } })}</section>` };
  }
  if (!servers.length) return { markup: `<section class="card">${EmptyState({ title: 'Aucun serveur configuré', cause: 'Renseignez DOKPLOY_URL et DOKPLOY_API_KEY dans l’environnement du service api.' })}</section>` };
  return { markup: `<div class="vps-cols${servers.length === 1 ? ' vps-cols--one' : ''}">${servers.map(serverColumn).join('')}</div>`, after: autoRefresh };
}
