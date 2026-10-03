/* Sections de la page Paramètres : procédure LinkedIn (repliable), Dokploy (capacités détectées), Session, À propos.
   Aucun secret : noms de variables d'environnement uniquement, jamais leurs valeurs. */
import { esc, isNum, fmtDateTime } from '../core/format.js?v=15';
import { PLATFORMS, MON_LABEL } from '../core/labels.js?v=15';
import { StatusBadge, SectionHeader, Details } from '../ui/components.js?v=15';
import { infraModel, isDokployUrl } from './infra-shared.js?v=15';
import { liveEnabled } from '../core/live.js?v=15';

// ---------------------------------------------------------------- LinkedIn
const ENV_VARS = ['LINKEDIN_CLIENT_ID', 'LINKEDIN_CLIENT_SECRET', 'LINKEDIN_ORGANIZATION_ID', 'LINKEDIN_COMMUNITY_API', 'LINKEDIN_SCOPES', 'LINKEDIN_API_VERSION'];
/** Panneau REPLIABLE « Procédure d'accès LinkedIn » (cette page uniquement). `st` = réponse de /api/status ou null. */
export function linkedinProcedure(st) {
  const li = st && st.platforms && st.platforms.linkedin;
  const server = li && Array.isArray(li.pendingSteps) && li.pendingSteps.length ? `<h3 class="steps__title">Étapes restantes signalées par le serveur</h3><ol class="steps">${li.pendingSteps.map((x) => `<li>${esc(x)}</li>`).join('')}</ol>` : '';
  const html = `<ol class="steps steps--proc">
      <li>Sur LinkedIn Developers, l’application doit avoir le produit « Community Management API » (niveau Development) accordé. Tant qu’il est en attente, aucune statistique LinkedIn n’est affichée.</li>
      <li>Dans l’onglet Auth de l’application, déclarez l’URL de redirection : <code>${esc(location.origin)}/api/auth/linkedin/callback</code></li>
      <li>Côté serveur (Dokploy, onglet Environment), renseignez les variables d’environnement ${ENV_VARS.map((v) => `<code>${v}</code>`).join(', ')} (mettez <code>LINKEDIN_COMMUNITY_API=true</code> une fois l’accès accordé ; <code>LINKEDIN_SCOPES</code> et <code>LINKEDIN_API_VERSION</code> sont facultatives). Ne saisissez jamais ces valeurs dans le dashboard.</li>
      <li>Redéployez le dashboard pour prendre en compte les variables.</li>
      <li>Cliquez sur « Connecter » à la ligne LinkedIn du tableau, avec un super administrateur de la Page, puis acceptez les autorisations.</li>
      <li>Le jeton LinkedIn est valable 60 jours : reconnectez le compte avant l’échéance si aucun renouvellement n’est indiqué.</li>
    </ol>${server}`;
  return `<div class="proc">${Details({ summary: 'Procédure d’accès LinkedIn', html, id: 'linkedin-proc' })}</div>`;
}

// ---------------------------------------------------------------- Dokploy
const SOURCE = { openapi: 'Schéma OpenAPI de l’instance', official_source: 'Source officielle de Dokploy (version vérifiée)', version: 'Version de Dokploy connue', unknown: 'Non déterminée' };
const CAP = {
  supported: { kind: 'ok', label: 'Disponible' },
  unsupported: { kind: 'info', label: 'Non supporté' },
  unknown: { kind: 'neutral', label: 'Inconnue' }
};
const capBadge = (v) => StatusBadge(CAP[v] || CAP.unknown);

/** Origine de l'instance Dokploy (sans chemin ni secret), déduite d'un lien de service validé ; sinon null. */
export function instanceOrigin(d) {
  for (const x of [...(d.services || []), ...(d.deployments || [])]) if (isDokployUrl(x.dokployUrl)) return new URL(x.dokployUrl).origin;
  return null;
}

function capabilityRows(d, m) {
  const c = d.capabilities || {}, server = m.server;
  const mon = server.status || 'unknown';
  const rows = [
    { name: 'Journaux de déploiement', badge: capBadge(c.deploymentLogs || 'unknown'), reason: c.deploymentLogsReason || 'Capacité non déterminée.', source: `${SOURCE[c.deploymentLogsSource] || SOURCE.unknown}${c.deploymentLogsTransport === 'websocket' ? ' · transport WebSocket' : ''}` },
    { name: 'Rechargement des applications', badge: capBadge(c.reload || 'unknown'), reason: c.reloadReason || (c.reload === 'supported' ? 'Disponible pour les applications ; non disponible pour les services Compose.' : 'Capacité non déterminée.'), source: c.schema === 'available' ? SOURCE.openapi : 'Schéma OpenAPI inaccessible : détection par version' },
    { name: 'Monitoring du VPS', badge: StatusBadge({ kind: mon === 'available' ? 'ok' : mon === 'unsupported' ? 'info' : mon === 'unknown' ? 'neutral' : 'warn', label: MON_LABEL[mon] || 'État indéterminé' }), reason: server.message || (mon === 'available' ? 'Mesures reçues.' : 'Aucune précision fournie par Dokploy.'), source: m.sourceLabel + (m.modeLabel ? ` · ${m.modeLabel}` : '') }
  ];
  return rows;
}

/** Section « Dokploy ». infra = résultat settled de Api.getInfrastructure(). */
export function dokploySection(infra) {
  const retry = '<button type="button" class="btn btn-ghost btn-small" data-infra-retry>Réessayer</button>';
  if (infra.status !== 'fulfilled') return `<section class="card" aria-labelledby="set-dok">${SectionHeader({ title: 'Dokploy', id: 'set-dok', actions: retry })}<p class="infra-failure" role="alert">${esc((infra.reason && infra.reason.message) || 'Dokploy indisponible.')}</p></section>`;
  const d = infra.value, m = infraModel(d), origin = instanceOrigin(d);
  const rows = capabilityRows(d, m);
  return `<section class="card" aria-labelledby="set-dok">${SectionHeader({ title: 'Dokploy', sub: 'La connexion est configurée côté serveur ; aucune clé n’est affichée.', id: 'set-dok', actions: retry })}
    <dl class="kv">
      <div><dt>API Dokploy</dt><dd>${m.connBadge}</dd></div>
      <div><dt>Version</dt><dd>${d.version ? `Dokploy ${esc(d.version)}` : 'Indisponible'}</dd></div>
      <div><dt>Instance</dt><dd>${origin ? `<code>${esc(origin)}</code>` : 'Non communiquée par l’API'}</dd></div>
    </dl>
    ${d.status === 'error' ? `<p class="infra-failure" role="alert">${esc((d.notes || [])[0] || 'Dokploy indisponible.')}</p>` : ''}
    <h3 class="sub-title">Capacités détectées</h3>
    <div class="table-wrap"><table class="data dt__table caps-table"><caption class="sr-only">Capacités détectées sur l’instance Dokploy : statut, raison et source de la détection</caption>
      <thead><tr><th scope="col">Capacité</th><th scope="col">Statut</th><th scope="col">Raison</th><th scope="col">Source</th></tr></thead>
      <tbody>${rows.map((r) => `<tr><td data-label="Capacité"><strong>${esc(r.name)}</strong></td><td data-label="Statut">${r.badge}</td><td data-label="Raison" class="dt__wide">${esc(r.reason)}</td><td data-label="Source" class="dt__wide">${esc(r.source)}</td></tr>`).join('')}</tbody></table></div>
  </section>`;
}

// ---------------------------------------------------------------- Session
export const sessionSection = () => `<section class="card" aria-labelledby="set-ses">${SectionHeader({ title: 'Session', sub: 'L’accès au dashboard est protégé par mot de passe.', id: 'set-ses' })}<button type="button" class="btn btn-ghost" data-logout>Se déconnecter</button></section>`;

// ---------------------------------------------------------------- Affichage : mode en direct
/** Préférence « Mode en direct » (activée par défaut, conservée dans ce navigateur). Coche native : clavier et lecteurs d'écran gérés par le navigateur. */
export function displaySection() {
  return `<section class="card" aria-labelledby="set-dsp">${SectionHeader({ title: 'Affichage', id: 'set-dsp', sub: 'Préférence enregistrée dans ce navigateur uniquement.' })}
    <div class="pref"><label class="pref__row" for="pref-live"><input type="checkbox" id="pref-live" data-live-pref${liveEnabled() ? ' checked' : ''} aria-describedby="pref-live-d"><span class="pref__label">Mode en direct</span></label>
    <p class="muted" id="pref-live-d">Tant que cet onglet est visible et utilisé, les mesures du serveur Dokploy sont relues toutes les 3 à 5 s et les réseaux sociaux toutes les 20 s (LinkedIn n’est jamais relancé automatiquement). Onglet masqué ou inactif depuis 5 minutes : tout s’arrête et reprend à votre retour. Désactivé, les données ne changent qu’au rechargement ou avec « Actualiser ».</p></div>
  </section>`;
}

// ---------------------------------------------------------------- À propos
export function fmtTtl(sec) {
  if (!isNum(sec) || sec <= 0) return null;
  if (sec < 120) return `${Math.round(sec)} s`;
  if (sec < 7200) return `${Math.round(sec / 60)} min`;
  return `${Math.round(sec / 3600)} h`;
}
/** Section « À propos » : version (si connue), TTL de cache, quotas. st = réponse de /api/status ou null. */
export function aboutSection(st) {
  const platforms = (st && st.platforms) || {};
  const version = st && (st.appVersion || st.version);
  const global = st && fmtTtl(st.cacheTtlSeconds);
  const per = PLATFORMS.map((p) => ({ p, t: fmtTtl(platforms[p] && platforms[p].cacheTtlSeconds) })).filter((x) => x.t);
  const label = { tiktok: 'TikTok', instagram: 'Instagram', linkedin: 'LinkedIn' };
  const budget = platforms.linkedin && platforms.linkedin.budget;
  return `<section class="card" aria-labelledby="set-abt">${SectionHeader({ title: 'À propos', id: 'set-abt' })}
    <dl class="kv">
      ${version ? `<div><dt>Version de l’application</dt><dd>${esc(version)}</dd></div>` : ''}
      <div><dt>Durée de cache des données</dt><dd>${per.length ? per.map((x) => `${esc(label[x.p])} : ${esc(x.t)}`).join(' · ') : global ? esc(global) : 'Indisponible'}</dd></div>
      <div><dt>Quotas</dt><dd>LinkedIn : 100 appels par jour et par membre (niveau Development)${budget && isNum(budget.limit) ? `, dont un budget interne de ${esc(budget.limit)} appels` : ''}. Actualisation manuelle : 60 s minimum entre deux demandes pour un même réseau.</dd></div>
      ${st && st.serverTime ? `<div><dt>Heure du serveur</dt><dd>${esc(fmtDateTime(st.serverTime))}</dd></div>` : ''}
    </dl>
    <p class="muted"><a class="text-link" href="confidentialite">Confidentialité</a> · <a class="text-link" href="conditions">Conditions d’utilisation</a></p>
  </section>`;
}
