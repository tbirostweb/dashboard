/* Déploiements (#/deployments) : compteurs par statut et taux de réussite (calculés à partir des lignes), filtres, DataTable triable,
   journaux dans un panneau latéral (infra-logs.js). applyLive(payload) accepte {deployments: [...]} (voir infra-live.js). */
import { esc } from '../core/format.js?v=16';
import { EmptyState, StatusBadge } from '../ui/components.js?v=16';
import { infraBanner, infraFailure, setLastInfra, lastInfra, deploymentsDataTable, deploymentCounters, filterBar, logsUnsupported, refreshResults, infraData } from './infra-shared.js?v=16';

const Api = window.Api;
export const title = 'Déploiements';
export const eyebrow = '';
export const usesToolbar = false;

/** Met à jour les déploiements sans re-rendre la page (tri, filtres, pagination et focus conservés). */
export function applyLive(payload) {
  if (!document.getElementById('results-deployments') || !payload || typeof payload !== 'object' || Array.isArray(payload) || !lastInfra) return false;
  const hasD = Array.isArray(payload.deployments), hasS = Array.isArray(payload.services);
  if (!hasD && !hasS) return true; // rien de nouveau pour cette page (mesures du VPS : sans objet ici)
  setLastInfra({ ...lastInfra, ...(hasS ? { services: payload.services } : {}), ...(hasD ? { deployments: payload.deployments } : {}), ...(payload.capabilities ? { capabilities: payload.capabilities } : {}) });
  if (hasD) refreshResults('deployments');
  return true;
}

export async function render() {
  try {
    const d = await Api.getInfrastructure();
    setLastInfra(d);
    if (d.status === 'error') return { markup: infraBanner((d.notes || [])[0] || 'Dokploy indisponible.') };
    const deployments = d.deployments || [], blocked = logsUnsupported(d);
    const sub = deployments.length ? `${deployments.length} déploiement${deployments.length > 1 ? 's' : ''} disponibles : les plus récents de chaque service, selon Dokploy` : '';
    const markup = `<section class="card" aria-labelledby="dep-h">
      <div class="card__head"><div><h2 class="card__title" id="dep-h">Historique des déploiements</h2>${sub ? `<span class="card__sub">${esc(sub)}</span>` : ''}</div></div>
      ${blocked ? `<div class="capability-note" id="logs-unsupported" role="note">${StatusBadge({ kind: 'info', label: 'Journaux non supportés' })}<p>${esc(blocked)}</p></div>` : ''}
      ${deployments.length
    ? `<div data-live-counters="deployments">${deploymentCounters(deployments)}</div>${filterBar('deployments', deployments, 'Filtrer les déploiements')}<div id="results-deployments">${deploymentsDataTable(d)}</div>`
    : EmptyState({ title: 'Aucun déploiement accessible', cause: 'Dokploy n’a renvoyé aucun déploiement pour les services accessibles.' })}
    </section>`;
    return { markup, applyLive, infraData };
  } catch (err) { if (err && err.code === 'unauthenticated') throw err; return { markup: infraFailure(err) }; }
}
