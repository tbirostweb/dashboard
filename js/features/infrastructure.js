/* Infrastructure (#/infrastructure) : état de l'API Dokploy et du monitoring du VPS (deux statuts distincts), jauges à seuils,
   services (DataTable triable / filtrable, actions Redéployer / Recharger). Le contrat « données en direct » est décrit dans infra-live.js. */
import { esc } from '../core/format.js?v=17';
import { EmptyState, Details } from '../ui/components.js?v=17';
import { infraModel, infraBanner, infraFailure, setLastInfra, servicesDataTable, serviceCounters, filterBar, measuredText, measuredAt, infraData } from './infra-shared.js?v=17';
import { gaugeHtml, factsHtml, reasonHtml, detailsHtml, modeText, applyInfraLive, startMeasuredTicker } from './infra-live.js?v=17';

const Api = window.Api;
export const title = 'Infrastructure';
export const eyebrow = '';
export const usesToolbar = false;

/** Point d'entrée du polling : voir le contrat dans infra-live.js. */
export const applyLive = applyInfraLive;

function statusBlock(d, m) {
  const at = measuredAt(m.server);
  return `<dl class="infra-status">
    <div class="infra-status__item"><dt>API Dokploy</dt><dd><span data-live="api-status">${m.connBadge}</span><span class="muted" data-live="version">${d.version ? `Dokploy ${esc(d.version)}` : 'Version indisponible'}</span></dd></div>
    <div class="infra-status__item"><dt>Monitoring du VPS</dt><dd><span data-live="monitoring-status">${m.monBadge}</span><span class="muted"><span data-live="measured-at"${at ? ` data-observed="${esc(at)}"` : ''}>${esc(measuredText(m.server))}</span></span><span class="muted" data-live="mode">${esc(modeText(m))}</span></dd></div>
  </dl>`;
}

function resourcesSection(d, m) {
  return `<section class="card infra" data-infra-live aria-labelledby="inf-res">
    <div class="card__head"><div><h2 class="card__title" id="inf-res">État et ressources du VPS</h2><span class="card__sub">Ressources de l’hôte Dokploy : CPU, mémoire et stockage</span></div></div>
    ${statusBlock(d, m)}
    <div class="infra-reason" data-live="reason">${reasonHtml(d, m)}</div>
    <div class="gauges">${['cpu', 'ram', 'disk'].map((k) => `<div class="gauge" data-live="${k}">${gaugeHtml(m.gauges[k])}</div>`).join('')}</div>
    <div data-live="facts">${factsHtml(m)}</div>
    ${Details({ summary: 'Détails', className: 'infra-details', html: `<div data-live="details">${detailsHtml(d, m)}</div>` })}
    <p class="sr-only" role="status" aria-live="polite" aria-atomic="true" data-live="announce"></p>
  </section>`;
}

function servicesSection(d) {
  const services = d.services || [], projects = d.projects || [];
  const sub = services.length ? `${services.length} service${services.length > 1 ? 's' : ''}${projects.length ? ` dans ${projects.length} projet${projects.length > 1 ? 's' : ''}` : ''}` : '';
  return `<section class="card" aria-labelledby="inf-svc">
    <div class="card__head"><div><h2 class="card__title" id="inf-svc">Services</h2>${sub ? `<span class="card__sub">${esc(sub)}</span>` : ''}</div></div>
    ${services.length
    ? `<div data-live-counters="services">${serviceCounters(services)}</div>${filterBar('services', services, 'Filtrer les services')}<div id="results-services">${servicesDataTable(d)}</div>
       <p class="card__sub infra-footnote">Les ressources par conteneur ne sont pas affichées : Dokploy ne les fournit pas pour ces services.</p>`
    : EmptyState({ title: 'Aucun service accessible', cause: 'Vérifiez la configuration et les permissions Dokploy.' })}
  </section>`;
}

export async function render() {
  try {
    const d = await Api.getInfrastructure();
    setLastInfra(d);
    const m = infraModel(d);
    const markup = `${m.failed ? infraBanner((d.notes || [])[0] || 'Dokploy indisponible.') : ''}${resourcesSection(d, m)}${m.failed ? '' : servicesSection(d)}`;
    return { markup, applyLive, infraData, after() { startMeasuredTicker(); } };
  } catch (err) { if (err && err.code === 'unauthenticated') throw err; return { markup: infraFailure(err) }; }
}
