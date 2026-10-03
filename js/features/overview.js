/* Vue d'ensemble = SYNTHÈSE (aucune action destructive). Ordre : alerte unique (bandeau global « Action requise » du routeur, connections.js), 4 KPI, interactions par réseau, santé du serveur,
   meilleures publications, dernière activité. Les actions (redéployer, recharger) restent sur les pages Infrastructure et Déploiements. */
import { esc, isNum, number, pct, fmtDateTime, relTime } from '../core/format.js?v=15';
import { MON_LABEL, statusLabel, statusKind, engagementFormula } from '../core/labels.js?v=15';
import { KpiCard, kpiProps, StatusBadge, Meter, EmptyState, SectionHeader } from '../ui/components.js?v=15';
import { errorCard } from './connections.js?v=15';
import { bestPostsList } from './social-shared.js?v=15';
import { interactionsByNetwork } from './social-charts.js?v=15';
import { setLastInfra, lastInfra, infraData } from './infra-shared.js?v=15';
import { mergeInfra } from './infra-live.js?v=15';

const Api = window.Api;
export const title = "Vue d'ensemble";
export const eyebrow = '';
export const usesToolbar = false;

const DAY = 86400000;
const ratio = (used, total) => (isNum(used) && isNum(total) && total > 0 ? used / total * 100 : null);
const gib = (b) => (isNum(b) ? `${(b / 1024 ** 3).toFixed(1).replace('.', ',')} Gio` : null);

/** Déploiements en échec sur 24 h à partir de /api/infrastructure (déjà chargé) ; null si Dokploy est indisponible. */
function failedKpi(infra, infraErr) {
  if (!infra || infra.status === 'error' || infra.status === 'not_configured') {
    const why = infra && infra.status === 'not_configured' ? 'Dokploy n’est pas configuré.' : (infraErr && infraErr.message) || (infra && infra.notes && infra.notes[0]) || 'Dokploy indisponible.';
    return KpiCard({ label: 'Déploiements en échec (24 h)', value: null, hint: why });
  }
  const since = Date.now() - DAY;
  const recent = (infra.deployments || []).filter((d) => Date.parse(d.createdAt) >= since);
  const failed = recent.filter((d) => d.status === 'error').length;
  return KpiCard({
    label: 'Déploiements en échec (24 h)', value: number(failed),
    deltaReason: `${recent.length} déploiement${recent.length > 1 ? 's' : ''} sur 24 h. Pas de comparaison : seule la dernière journée est lue.`,
    hint: failed ? 'Consultez la page Déploiements pour le détail.' : undefined
  });
}

const healthHead = SectionHeader({ title: 'Santé du serveur', level: 2, actions: '<a class="text-link" href="#/infrastructure">Infrastructure</a>' });
function healthBody(infra, infraErr) {
  if (!infra || infra.status === 'error' || infra.status === 'not_configured') {
    const msg = infra && infra.status === 'not_configured' ? 'Dokploy n’est pas configuré sur le serveur.' : (infraErr && infraErr.message) || (infra && infra.notes && infra.notes[0]) || 'Dokploy est injoignable.';
    return `${StatusBadge({ kind: infra && infra.status === 'not_configured' ? 'neutral' : 'error', label: infra && infra.status === 'not_configured' ? 'Non configuré' : 'Injoignable' })}<p class="muted">${esc(msg)}</p>`;
  }
  const s = infra.server || {}, m = s.status === 'available' ? s : {};
  const mon = s.status || 'unknown';
  const kind = statusKind(mon);
  return `${StatusBadge({ kind, label: MON_LABEL[mon] || 'État indéterminé' })}
    <div class="meters">${Meter({ label: 'CPU', percent: m.cpuPercent })}
      ${Meter({ label: 'Mémoire (RAM)', percent: ratio(m.ramUsedBytes, m.ramTotalBytes), detail: isNum(m.ramUsedBytes) && isNum(m.ramTotalBytes) ? `${gib(m.ramUsedBytes)} sur ${gib(m.ramTotalBytes)}` : undefined })}
      ${Meter({ label: 'Stockage', percent: ratio(m.storageUsedBytes, m.storageTotalBytes), detail: isNum(m.storageUsedBytes) && isNum(m.storageTotalBytes) ? `${gib(m.storageUsedBytes)} sur ${gib(m.storageTotalBytes)}` : undefined })}</div>
    ${s.observedAt ? `<p class="muted">Mesure du <time datetime="${esc(s.observedAt)}">${esc(fmtDateTime(s.observedAt))}</time></p>` : ''}
    ${s.status !== 'available' && s.message ? `<p class="muted">${esc(s.message)}</p>` : ''}`;
}
const healthPanel = (infra, infraErr) => `<section class="card side-card" aria-label="Santé du serveur">${healthHead}<div class="side-live" data-live="ov-health">${healthBody(infra, infraErr)}</div></section>`;

const depLine = (d) => `<li class="activity__item"><div class="activity__main"><span class="activity__ctx">${esc(d.context || d.serviceName || 'Service inconnu')}</span><span class="muted">${d.createdAt ? `<time datetime="${esc(d.createdAt)}" title="${esc(fmtDateTime(d.createdAt))}">${esc(relTime(d.createdAt))}</time>` : 'Date indisponible'}</span></div>${StatusBadge({ kind: statusKind(d.status), label: statusLabel(d.status) })}</li>`;

function lastDeploymentBody(infra) {
  const deps = infra && infra.status !== 'error' && infra.status !== 'not_configured' ? infra.deployments || [] : [];
  const last = deps[0];
  return last
    ? `<p class="activity__ctx">${esc(last.context || last.serviceName || 'Service inconnu')}</p>${StatusBadge({ kind: statusKind(last.status), label: statusLabel(last.status) })}<p class="muted">${last.createdAt ? esc(fmtDateTime(last.createdAt)) : 'Date indisponible'}</p><a class="text-link" href="#/deployments">Tous les déploiements</a>`
    : '<p class="muted">Aucun déploiement lu pour le moment.</p>';
}
const lastDeploymentPanel = (infra) => `<section class="card side-card" aria-labelledby="ov-lastdep"><h2 class="card__title" id="ov-lastdep">Dernier déploiement</h2><div class="side-live" data-live="ov-lastdep">${lastDeploymentBody(infra)}</div></section>`;

function activityBody(infra) {
  const deps = infra && infra.status !== 'error' && infra.status !== 'not_configured' ? (infra.deployments || []).slice(0, 3) : [];
  return deps.length ? `<ul class="activity">${deps.map(depLine).join('')}</ul>` : EmptyState({ title: 'Aucune activité', cause: 'Aucun déploiement récent n’a pu être lu.' });
}
const activityPanel = (infra) => `<section class="card" aria-labelledby="ov-act">${SectionHeader({ title: 'Dernière activité', id: 'ov-act', sub: '3 derniers déploiements', actions: '<a class="text-link" href="#/deployments">Voir tout</a>' })}<div data-live="ov-activity">${activityBody(infra)}</div></section>`;

/** Mode en direct : met à jour la santé du serveur, le KPI d'échecs et les déploiements SANS re-rendre la page (focus, défilement conservés). Contrat : voir infra-live.js. */
export function applyLive(payload) {
  if (!document.querySelector('[data-live="ov-health"]') || !lastInfra || !payload || typeof payload !== 'object' || Array.isArray(payload)) return false;
  const next = mergeInfra(lastInfra, payload);
  setLastInfra(next);
  const set = (key, html) => { const el = document.querySelector(`[data-live="${key}"]`); if (el && el._h !== html) { el._h = html; el.innerHTML = html; } };
  set('ov-health', healthBody(next, null));
  set('ov-failed', failedKpi(next, null));
  set('ov-lastdep', lastDeploymentBody(next));
  set('ov-activity', activityBody(next));
  return true;
}

export async function render(ctx) {
  const [social, infra] = await Promise.allSettled([Api.getOverview({ period: ctx.period }), Api.getInfrastructure()]);
  const sv = social.status === 'fulfilled' ? social.value : null, iv = infra.status === 'fulfilled' ? infra.value : null;
  if (!sv && social.reason && social.reason.code === 'unauthenticated') throw social.reason;
  setLastInfra(iv || null);
  const P = ctx.period;

  let top = '', main = '', chart = null;
  if (sv) {
    const t = sv.totals || {};
    const kp = (k, rate) => ({ ...kpiProps(k, { period: P, rate }) });
    const f = t.followers, i = t.interactions, e = t.engagementRate;
    const kpis = `<section class="kpis kpis--4" aria-label="Indicateurs clés">
      ${KpiCard({ label: 'Abonnés totaux', value: f && isNum(f.value) ? f.value : null, ...kp(f), hint: f && !isNum(f.value) ? f.reason : undefined, basis: f && f.basis })}
      ${KpiCard({ label: 'Interactions totales', value: i && isNum(i.value) ? i.value : null, ...kp(i), hint: i && !isNum(i.value) ? i.reason : undefined, basis: i && i.basis })}
      ${KpiCard({ label: "Taux d'engagement global", value: e && isNum(e.value) ? pct(e.value) : null, ...kp(e, true), hint: e && !isNum(e.value) ? e.reason : undefined, basis: engagementFormula(e && e.basis) })}
      <div class="live-slot" data-live="ov-failed">${failedKpi(iv, infra.reason)}</div>
    </section>`;
    chart = interactionsByNetwork(sv, { id: 'ov-line', period: P });
    top = kpis;
    main = `${chart.markup}<section class="card" aria-labelledby="ov-best">${SectionHeader({ title: 'Publications les plus performantes', id: 'ov-best', sub: `${P} derniers jours, classées par interactions`, actions: '<a class="text-link" href="#/social">Réseaux sociaux</a>' })}${bestPostsList(sv.topPosts, { max: 5 })}</section>`;
  } else {
    main = errorCard(social.reason);
  }
  const markup = `${top}
    <div class="ov-grid"><div class="ov-main">${main}</div><aside class="ov-side" aria-label="Infrastructure">${healthPanel(iv, infra.reason)}${lastDeploymentPanel(iv)}</aside></div>
    ${activityPanel(iv)}`;
  return { markup, applyLive, infraData, after() { if (chart) chart.after(); } };
}
