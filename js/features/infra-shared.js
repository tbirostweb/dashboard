/* Pièces Dokploy partagées : modèle de monitoring, tableaux (services, déploiements), actions Redéployer / Recharger,
   filtres, compteurs. Attributs délégués à CONSERVER : data-redeploy, data-reload, data-logs, data-filter, data-infra-retry, data-tracker-close.
   La page Infrastructure (gauges, applyLive) vit dans infrastructure.js + infra-live.js ; les journaux dans infra-logs.js. */
import { esc, fmtDate, fmtDateTime, fmtDuration, gio, pct, norm, isNum, relTime } from '../core/format.js?v=17';
import { statusLabel, statusKind, MON_LABEL, CONN_LABEL, TYPE_LABEL } from '../core/labels.js?v=17';
import { state } from '../core/state.js?v=17';
import { rerender } from '../core/router.js?v=17';
import { StatusBadge, Ring, DataTable, updateDataTable, Counters, ButtonGroup } from '../ui/components.js?v=17';
import { confirmAction } from '../ui/dialog.js?v=17';
import { redeployBusy, syncRedeployButtons } from './deploy-tracker.js?v=17';
import { dokployLink, isDokployUrl, openLogs } from './infra-logs.js?v=17';

export { dokployLink, isDokployUrl };

const Api = window.Api;
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const filters = state.filters;

export let lastInfra = null;
export const setLastInfra = (d) => { lastInfra = d; if (d && Api.putInfrastructure) Api.putInfrastructure(d); };
/** Données chargées de la page (services, déploiements) : lues par le mode en direct pour fusionner /live sans écraser les autres champs. */
export const infraData = () => lastInfra;

export const statusBadge = (s, label) => StatusBadge({ kind: statusKind(s), label: label == null ? statusLabel(s) : label });
export const connLabel = (d) => { const c = d.connection || { status: d.status, reason: d.reason }; return c.status === 'error' ? (CONN_LABEL[c.reason] || 'Erreur de l’API') : (CONN_LABEL[c.status] || statusLabel(c.status)); };

// ---------------------------------------------------------------- Libellés
/** Statut d'un SERVICE (Dokploy : done = en ligne, running = déploiement en cours, idle = inactif). */
const SERVICE_LABEL = { done: 'En ligne', healthy: 'En ligne', active: 'En ligne', running: 'Déploiement en cours', idle: 'Inactif', error: 'En erreur', failed: 'En erreur', cancelled: 'Annulé' };
export const serviceStatusLabel = (s) => SERVICE_LABEL[s] || statusLabel(s);
export const serviceBadge = (s) => StatusBadge({ kind: statusKind(s), label: serviceStatusLabel(s) });
/** Statut d'un DÉPLOIEMENT. */
const DEPLOY_LABEL = { done: 'Réussi', error: 'Échec', failed: 'Échec', running: 'En cours', cancelled: 'Annulé' };
export const deployStatusLabel = (s) => DEPLOY_LABEL[s] || statusLabel(s);
export const deployBadge = (s) => StatusBadge({ kind: statusKind(s), label: deployStatusLabel(s) });

// ---------------------------------------------------------------- Horodatages
const pad = (n) => String(n).padStart(2, '0');
export const clockOf = (s) => { const d = new Date(s); return Number.isNaN(d.getTime()) ? null : `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`; };
export function agoText(s, now = Date.now()) {
  const t = Date.parse(s); if (!Number.isFinite(t)) return null;
  const sec = Math.max(0, Math.round((now - t) / 1000));
  return sec < 60 ? `il y a ${sec} s` : sec < 3600 ? `il y a ${Math.floor(sec / 60)} min` : sec < 86400 ? `il y a ${Math.floor(sec / 3600)} h` : `il y a ${Math.floor(sec / 86400)} j`;
}
/** « Mesure du 14:05:03 (il y a 4 s) » ; autre jour : « Mesure du 30 sept. 2026 à 14:05:03 (il y a 1 j) ». Source : observedAt, sinon sampleAt. */
export function measuredText(server, now = Date.now()) {
  const at = server && (server.observedAt || server.sampleAt);
  const clock = at && clockOf(at);
  if (!clock) return 'Heure de mesure inconnue';
  const same = new Date(at).toDateString() === new Date(now).toDateString();
  return `Mesure du ${same ? '' : `${fmtDate(at)} à `}${clock} (${agoText(at, now)})`;
}
export const measuredAt = (server) => (server && (server.observedAt || server.sampleAt)) || null;

// ---------------------------------------------------------------- Modèle de monitoring
const usageText = (used, total) => {
  const u = isNum(used), t = isNum(total);
  if (u && t) return `${gio(used)} / ${gio(total)}`;
  if (u) return `Utilisé : ${gio(used)}`;
  if (t) return `Capacité : ${gio(total)}`;
  return null;
};
const ratio = (used, total) => (isNum(total) && total > 0 && isNum(used) ? used / total * 100 : null);

export const infraBanner = (message) => `<div class="infra-banner" role="alert"><span>${esc(message)}</span><button type="button" class="btn btn-ghost btn-small" data-infra-retry>Réessayer</button></div>`;
export const infraFailure = (err) => infraBanner((err && err.message) || 'Dokploy indisponible.');

/** Modèle d'affichage commun (Infrastructure, Vue d'ensemble, applyLive). Une mesure ancienne ou absente n'est JAMAIS affichée comme actuelle. */
export function infraModel(d) {
  const server = d.server || {}, failed = d.status === 'error', conn = d.connection || {};
  const measured = server.status === 'available' ? server : {};
  const cpu = isNum(measured.cpuPercent) ? measured.cpuPercent : null;
  const ram = ratio(measured.ramUsedBytes, measured.ramTotalBytes), disk = ratio(measured.storageUsedBytes, measured.storageTotalBytes);
  const monState = server.status || 'unknown';
  const connC = d.connection || { status: d.status, reason: d.reason };
  const gauges = {
    cpu: { label: 'CPU', percent: cpu, detail: null },
    ram: { label: 'RAM', percent: ram, detail: usageText(measured.ramUsedBytes, measured.ramTotalBytes) },
    disk: { label: 'Stockage', percent: disk, detail: usageText(measured.storageUsedBytes, measured.storageTotalBytes) }
  };
  return {
    server, failed, conn, monState, gauges, measured,
    rings: Object.values(gauges).map((g) => Ring({ label: g.label, percent: g.percent, detail: g.detail })).join(''),
    connKind: connC.status === 'connected' ? 'connected' : connC.status === 'error' ? 'error' : 'not_configured',
    connBadge: statusBadge(connC.status === 'connected' ? 'connected' : connC.status === 'error' ? 'error' : 'not_configured', connLabel(d)),
    monBadge: statusBadge(monState, MON_LABEL[monState] || 'État indéterminé'),
    sourceLabel: server.source === 'dokploy_native' ? 'Monitoring natif Dokploy' : server.source === 'dokploy_advanced' || server.source === 'advanced' || server.source === 'dokploy_agent' ? 'Agent de monitoring Dokploy' : '',
    modeLabel: server.monitoringMode === 'snapshot' ? 'Lecture ponctuelle lors du rafraîchissement' : server.monitoringMode === 'stream' ? 'Flux de mesures en continu' : ''
  };
}

// ---------------------------------------------------------------- Contexte et actions
// Contexte « Projet → Environnement → Service » : champs manquants affichés comme inconnus, jamais inventés.
export const ctxOf = (x) => x.context || [x.projectName || 'Projet inconnu', x.environmentName || 'Environnement inconnu', x.serviceName || x.name || 'Service inconnu'].join(' → ');

const redeployButton = (s) => { const busy = redeployBusy(s.status, s.id, s.name); return `<button type="button" class="btn btn-strong btn-small" data-redeploy="${esc(s.id)}" data-service-type="${esc(s.type)}" data-service-name="${esc(s.name || 'Service inconnu')}" data-service-context="${esc(ctxOf(s))}" data-status="${esc(s.status)}" aria-label="Redéployer ${esc(ctxOf(s))}" title="Reconstruit puis redéploie le service"${busy ? ' disabled aria-disabled="true"' : ''}>${busy ? 'En cours' : 'Redéployer'}</button>`; };
// « Recharger » ≠ « Redéployer » : réapplique la configuration sans reconstruction (applications uniquement).
const reloadButton = (s) => { const busy = redeployBusy(s.status, s.id, s.name); return `<button type="button" class="btn btn-ghost btn-small" data-reload="${esc(s.id)}" data-service-name="${esc(s.name || 'Service inconnu')}" data-service-context="${esc(ctxOf(s))}" data-status="${esc(s.status)}" aria-label="Recharger ${esc(ctxOf(s))} : réapplique la configuration sans reconstruire" title="Réapplique la configuration sans reconstruire"${busy ? ' disabled aria-disabled="true"' : ''}>${busy ? 'En cours' : 'Recharger'}</button>`; };
// Capacité absente : bouton inactif et motif. Pas de data-reload : syncRedeployButtons() ne doit jamais le réactiver.
const reloadDisabled = (reason) => `<button type="button" class="btn btn-ghost btn-small" disabled aria-disabled="true" title="${esc(reason)}">Recharger<span class="sr-only"> indisponible : ${esc(reason)}</span></button>`;

/** Actions d'un service : Redéployer (principal), Recharger (secondaire), Voir dans Dokploy (discret). caps = d.capabilities. */
export function serviceActions(s, caps = null) {
  const link = dokployLink(s.dokployUrl, ctxOf(s));
  if (!s.canRedeploy) return `<span class="muted">Actions indisponibles</span>${link ? ButtonGroup(link, `Liens pour ${ctxOf(s)}`) : ''}`;
  let reload = '';
  if (s.canReload) reload = reloadButton(s);
  else if (s.type === 'application' && caps && caps.reload === 'unsupported') reload = reloadDisabled(caps.reloadReason || 'Rechargement indisponible sur cette version de Dokploy.');
  const note = s.type === 'compose' ? '<span class="sr-only">Le rechargement n’est pas disponible pour les services Compose dans Dokploy.</span>' : '';
  return `${ButtonGroup(redeployButton(s) + reload + link, `Actions pour ${ctxOf(s)}`)}${note}`;
}

// ---------------------------------------------------------------- Filtres (services et déploiements)
const projectKey = (x) => x.projectId || '__unknown';
function projectOptions(items) {
  const byKey = new Map();
  for (const x of items) if (!byKey.has(projectKey(x))) byKey.set(projectKey(x), x.projectName || 'Projet inconnu');
  const names = [...byKey.values()];
  return [...byKey].map(([key, name]) => [key, names.filter((n) => n === name).length > 1 ? `${name} (${key === '__unknown' ? 'sans identifiant' : key.slice(0, 6)})` : name]).sort((a, b) => a[1].localeCompare(b[1], 'fr'));
}
function filterItems(kind, items) {
  const f = filters[kind], q = norm(f.q).trim(), lab = kind === 'deployments' ? deployStatusLabel : serviceStatusLabel;
  return items.filter((x) => (!f.project || projectKey(x) === f.project) && (!f.status || x.status === f.status)
    && (!q || norm([ctxOf(x), x.projectName, x.environmentName, x.serviceName || x.name, x.appName, x.type || x.serviceType, x.serviceId || x.id, lab(x.status), statusLabel(x.status)].join(' ')).includes(q)));
}
/** Barre de filtres (recherche, projet, statut) : data-filter conservé, état dans state.filters (survit aux rafraîchissements). */
export function filterBar(kind, items, label) {
  const f = filters[kind], lab = kind === 'deployments' ? deployStatusLabel : serviceStatusLabel;
  const opt = (list, value) => list.map(([v, l]) => `<option value="${esc(v)}"${v === value ? ' selected' : ''}>${esc(l)}</option>`).join('');
  const statuses = [...new Set(items.map((x) => x.status).filter(Boolean))].map((s) => [s, lab(s)]).sort((a, b) => a[1].localeCompare(b[1], 'fr'));
  return `<div class="filters infra-filters" role="search" aria-label="${esc(label)}" data-filter-form="${kind}">
    <div class="field field--search"><label for="f-${kind}-q">Rechercher</label><input id="f-${kind}-q" type="search" data-filter="q" value="${esc(f.q)}" placeholder="Service, projet, environnement…" autocomplete="off" enterkeyhint="search"></div>
    <div class="field"><label for="f-${kind}-project">Projet</label><select id="f-${kind}-project" data-filter="project"><option value="">Tous les projets</option>${opt(projectOptions(items), f.project)}</select></div>
    <div class="field"><label for="f-${kind}-status">Statut</label><select id="f-${kind}-status" data-filter="status"><option value="">Tous les statuts</option>${opt(statuses, f.status)}</select></div>
    <button type="button" class="btn btn-ghost" data-filter-reset="${kind}">Réinitialiser</button></div>`;
}

// ---------------------------------------------------------------- Compteurs
/** Compteurs de services par état (tous les services, hors filtres). */
export function serviceCounts(services) {
  const c = { online: 0, deploying: 0, error: 0, idle: 0, other: 0 };
  for (const s of services) {
    if (['done', 'healthy', 'active'].includes(s.status)) c.online++;
    else if (s.status === 'running') c.deploying++;
    else if (['error', 'failed'].includes(s.status)) c.error++;
    else if (s.status === 'idle') c.idle++;
    else c.other++;
  }
  return c;
}
export function serviceCounters(services) {
  const c = serviceCounts(services);
  return Counters({ label: 'Services par état', items: [
    { key: 'online', label: 'En ligne', value: c.online, kind: 'ok' },
    { key: 'error', label: 'En erreur', value: c.error, kind: 'error' },
    { key: 'idle', label: 'Inactifs', value: c.idle, kind: 'neutral' },
    { key: 'deploying', label: 'En cours', value: c.deploying, kind: 'pending' },
    ...(c.other ? [{ key: 'other', label: 'Statut inconnu', value: c.other, kind: 'info' }] : [])
  ] });
}
/** Statistiques de déploiements. Taux de réussite = réussis ÷ (réussis + échecs + annulés) ; null s'il n'y a aucun déploiement terminé (jamais 0 par défaut). */
export function deploymentStats(rows) {
  const s = { done: 0, running: 0, failed: 0, cancelled: 0, other: 0, total: rows.length };
  for (const x of rows) {
    if (x.status === 'done') s.done++; else if (x.status === 'running') s.running++; else if (['error', 'failed'].includes(x.status)) s.failed++; else if (x.status === 'cancelled') s.cancelled++; else s.other++;
  }
  const finished = s.done + s.failed + s.cancelled;
  s.rate = finished > 0 ? s.done / finished * 100 : null;
  return s;
}
export function deploymentCounters(rows) {
  const s = deploymentStats(rows);
  return Counters({ label: 'Déploiements par statut', items: [
    { key: 'done', label: 'Réussis', value: s.done, kind: 'ok' },
    { key: 'running', label: 'En cours', value: s.running, kind: 'pending' },
    { key: 'failed', label: 'Échecs', value: s.failed, kind: 'error' },
    { key: 'cancelled', label: 'Annulés', value: s.cancelled, kind: 'neutral' },
    { key: 'rate', label: 'Taux de réussite', value: s.rate === null ? null : pct(s.rate, 1), hint: 'Réussis ÷ (réussis + échecs + annulés). Les déploiements en cours ne comptent pas ; sans déploiement terminé, le taux est indisponible.' }
  ] });
}

// ---------------------------------------------------------------- Tableaux DataTable
const dash = '<span aria-hidden="true">—</span><span class="sr-only">non disponible</span>';
const when = (iso) => (iso && !Number.isNaN(Date.parse(iso)) ? `<div class="cell"><time datetime="${esc(iso)}" title="${esc(fmtDateTime(iso))}">${esc(relTime(iso))}</time><span class="cell-sub">${esc(fmtDateTime(iso))}</span></div>` : dash);
const ts = (iso) => { const t = Date.parse(iso); return Number.isFinite(t) ? t : null; };

export const TABLE_ID = { services: 'svc-table', deployments: 'dep-table' };

export function servicesDataTable(d) {
  const all = d.services || [], rows = filterItems('services', all), caps = d.capabilities || null;
  return DataTable({
    id: TABLE_ID.services, rows, grand: all.length, pageSize: 50, caption: 'Services Dokploy : projet, environnement, type, statut, dernier déploiement et actions', empty: 'Aucun service pour ces filtres.',
    sort: { key: 'project', dir: 'asc' },
    columns: [
      { key: 'project', label: 'Projet', value: (s) => s.projectName || 'Projet inconnu', render: (s) => esc(s.projectName || 'Projet inconnu'), wrap: true },
      { key: 'environment', label: 'Environnement', value: (s) => s.environmentName || 'Environnement inconnu', render: (s) => esc(s.environmentName || 'Environnement inconnu'), wrap: true },
      { key: 'service', label: 'Service', value: (s) => s.serviceName || s.name || 'Service inconnu', render: (s) => `<strong class="ctx">${esc(s.serviceName || s.name || 'Service inconnu')}</strong>`, wrap: true },
      { key: 'type', label: 'Type', value: (s) => TYPE_LABEL[s.type] || s.type || null, render: (s) => `<span class="tag">${esc(TYPE_LABEL[s.type] || s.type || 'Inconnu')}</span>` },
      { key: 'status', label: 'Statut', value: (s) => serviceStatusLabel(s.status), render: (s) => serviceBadge(s.status) },
      { key: 'last', label: 'Dernier déploiement', value: (s) => ts(s.lastDeployment && s.lastDeployment.createdAt), render: (s) => when(s.lastDeployment && s.lastDeployment.createdAt), text: (s) => fmtDateTime(s.lastDeployment && s.lastDeployment.createdAt) },
      { key: 'actions', label: 'Actions', sortable: false, render: (s) => serviceActions(s, caps) }
    ]
  });
}

export const logsUnsupported = (d) => ((d.capabilities && d.capabilities.deploymentLogs === 'unsupported') ? (d.capabilities.deploymentLogsReason || `Dokploy ${d.version || ''} ne fournit pas la lecture des journaux via l’API. Consultez-les dans Dokploy.`) : null);

export function deploymentsDataTable(d) {
  const all = d.deployments || [], rows = filterItems('deployments', all), blocked = logsUnsupported(d);
  const actions = (x) => {
    const link = dokployLink(x.dokployUrl, ctxOf(x));
    const logs = blocked ? '<span class="muted" aria-describedby="logs-unsupported">Journaux indisponibles</span>'
      : `<button type="button" class="btn btn-strong btn-small" data-logs="${esc(x.id)}" data-logs-context="${esc(ctxOf(x))}" aria-label="Consulter les journaux : ${esc(ctxOf(x))}">Consulter</button>`;
    return ButtonGroup(logs + link, `Actions pour ${ctxOf(x)}`);
  };
  const errorLine = (x) => (x.errorMessage ? `<small class="cell-sub">Erreur : ${esc(x.errorMessage)}</small>` : x.errorMessageHidden ? '<small class="cell-sub">Message d’erreur masqué (contenu potentiellement sensible).</small>' : '');
  return DataTable({
    id: TABLE_ID.deployments, rows, grand: all.length, pageSize: 25, caption: 'Déploiements Dokploy : projet, environnement, service, statut, début, durée et actions', empty: 'Aucun déploiement pour ces filtres.',
    sort: { key: 'start', dir: 'desc' },
    columns: [
      { key: 'project', label: 'Projet', value: (x) => x.projectName || 'Projet inconnu', render: (x) => esc(x.projectName || 'Projet inconnu'), wrap: true },
      { key: 'environment', label: 'Environnement', value: (x) => x.environmentName || 'Environnement inconnu', render: (x) => esc(x.environmentName || 'Environnement inconnu'), wrap: true },
      { key: 'service', label: 'Service', value: (x) => x.serviceName || x.name || 'Service inconnu', render: (x) => `<div class="cell"><strong class="ctx">${esc(x.serviceName || x.name || 'Service inconnu')}</strong>${errorLine(x)}</div>`, wrap: true },
      { key: 'status', label: 'Statut', value: (x) => deployStatusLabel(x.status), render: (x) => deployBadge(x.status) },
      { key: 'start', label: 'Début', value: (x) => ts(x.createdAt), render: (x) => when(x.createdAt), text: (x) => fmtDateTime(x.createdAt) },
      { key: 'duration', label: 'Durée', numeric: true, value: (x) => (isNum(x.durationSeconds) ? x.durationSeconds : null), render: (x) => (fmtDuration(x.durationSeconds) ? esc(fmtDuration(x.durationSeconds)) : x.status === 'running' ? 'En cours' : dash) },
      { key: 'actions', label: 'Actions', sortable: false, render: actions }
    ]
  });
}

// ---------------------------------------------------------------- Rafraîchissement ciblé (filtres, applyLive, fin de suivi)
/** Exécute fn puis rend le focus à l'élément (re-trouvé par ses attributs) s'il a été remplacé par un redessin. */
export function keepFocus(fn) {
  const a = document.activeElement, content = document.getElementById('content');
  let sel = null;
  if (a && a !== document.body && content && content.contains(a)) {
    for (const attr of ['data-redeploy', 'data-reload', 'data-logs', 'data-dt-sort', 'data-dt-page']) { if (a.hasAttribute(attr)) { sel = `[${attr}="${CSS.escape(a.getAttribute(attr))}"]`; break; } }
    if (!sel && a.id) sel = `#${CSS.escape(a.id)}`;
  }
  fn();
  if (sel) { const el = document.querySelector(sel); if (el && el !== document.activeElement && !el.disabled) el.focus({ preventScroll: true }); }
}

export function refreshResults(kind) {
  if (!lastInfra) return;
  keepFocus(() => {
    const all = (kind === 'services' ? lastInfra.services : lastInfra.deployments) || [], rows = filterItems(kind, all);
    updateDataTable(TABLE_ID[kind], rows, all.length);
    if (kind === 'deployments') { const c = $('[data-live-counters="deployments"]'); if (c) c.innerHTML = deploymentCounters(rows); }
    if (kind === 'services') { const c = $('[data-live-counters="services"]'); if (c) c.innerHTML = serviceCounters(all); }
    syncRedeployButtons();
  });
}

// ---------------------------------------------------------------- Écouteurs délégués (installés une seule fois à l'import)
document.addEventListener('input', (e) => { const el = e.target.closest('[data-filter]'); if (!el) return; const form = el.closest('[data-filter-form]'); if (!form) return; filters[form.dataset.filterForm][el.dataset.filter] = el.value; refreshResults(form.dataset.filterForm); });
document.addEventListener('change', (e) => { const el = e.target.closest('select[data-filter]'); if (!el) return; const form = el.closest('[data-filter-form]'); if (!form) return; filters[form.dataset.filterForm][el.dataset.filter] = el.value; refreshResults(form.dataset.filterForm); });
document.addEventListener('click', (e) => {
  if (e.target.closest('[data-infra-retry]')) { Api.invalidate(); rerender().then(() => { const c = document.getElementById('content'); if (c) c.focus({ preventScroll: true }); }); return; }
  const reset = e.target.closest('[data-filter-reset]');
  if (reset) { const kind = reset.dataset.filterReset; filters[kind] = { q: '', project: '', status: '' }; $$(`[data-filter-form="${kind}"] [data-filter]`).forEach((el) => { el.value = ''; }); refreshResults(kind); const first = $(`#f-${kind}-q`); if (first) first.focus(); return; }
  const logs = e.target.closest('[data-logs]');
  if (logs) { openLogs(logs.dataset.logs, logs.dataset.logsContext || ''); return; }
  const reloadBtn = e.target.closest('[data-reload]');
  if (reloadBtn && !reloadBtn.disabled) {
    confirmAction(reloadBtn, { title: 'Confirmer le rechargement', confirm: 'Recharger', id: reloadBtn.dataset.reload,
      text: `<p>Recharger l’application <strong>${esc(reloadBtn.dataset.serviceName)}</strong> ?</p><p class="ctx-line">${esc(reloadBtn.dataset.serviceContext || '')}</p><p>Réapplique la configuration et relance les conteneurs, sans reconstruire. Coupure brève possible.</p>`,
      run: () => Api.reloadApplication(reloadBtn.dataset.reload), initial: 'Rechargement demandé. Suivi en cours…', failure: 'Échec du rechargement.' });
    return;
  }
  const button = e.target.closest('[data-redeploy]'); if (!button || button.disabled) return;
  confirmAction(button, { title: 'Confirmer le redéploiement', confirm: 'Redéployer', id: button.dataset.redeploy,
    text: `<p>Redéployer le service <strong>${esc(button.dataset.serviceName)}</strong> ? Cette opération peut interrompre brièvement le service.</p><p class="ctx-line">${esc(button.dataset.serviceContext || '')}</p>`,
    run: () => Api.redeploy(button.dataset.serviceType, button.dataset.redeploy), initial: undefined, failure: 'Échec de la demande.' });
});
