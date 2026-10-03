/* Mode en direct : logique PURE (aucun DOM, aucun réseau, aucune horloge implicite) — testée par backend/test/frontend-live.test.js.
   js/core/live.js s'en sert pour décider QUAND interroger, COMMENT temporiser après une erreur, QUOI fusionner et SI l'écran peut être mis à jour. */

// ---------------------------------------------------------------- Constantes de cadence
export const PING_INTERVAL_MS = 30_000;          // présence : POST /api/live/ping
export const IDLE_LIMIT_MS = 5 * 60_000;         // sans interaction : pause
export const INFRA_FAST_MS = 3_000;              // GET /api/infrastructure/live
export const INFRA_SLOW_MS = 5_000;              // mesure Dokploy plus lente que 10 s : inutile d'aller plus vite
export const INFRA_FLOOR_MS = 2_000;             // plancher absolu
export const INFRA_BACKOFF_MAX_MS = 30_000;
export const SOCIAL_MS = 20_000;                 // rafraîchissement des données sociales (le backend sert le cache)
export const SOCIAL_FAST_MS = 5_000;             // tant que des blocs sont « en chargement » côté backend
export const SOCIAL_BACKOFF_MAX_MS = 120_000;
export const MIN_GAP_MS = 250;                   // jamais deux requêtes collées l'une à l'autre
export const SETTLE_MS = 3_000;                  // défilement / sélection récents : on n'écrase pas l'écran
export const REPORT_AFTER_MS = 30_000;           // report plus long : « Nouvelles données disponibles — Actualiser »
export const SNAPSHOT_MIN_GAP_MS = 15_000;       // relecture du snapshot Dokploy complet (TTL serveur : 15 s)
export const CACHE_LABEL_AFTER_MS = 5 * 60_000;  // donnée plus vieille : « Données en cache »

const GIB = 1024 ** 3;
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

// ---------------------------------------------------------------- Présence : état du mode en direct
/**
 * État du gestionnaire. Entrées : enabled (préférence), authenticated, online, visible (Page Visibility), lastInteractionAt, now.
 * Retour : { active, state } avec state ∈ live | disabled | signed_out | offline | hidden | idle.
 * « active » est la SEULE condition qui autorise une requête périodique (ping, Dokploy, réseaux sociaux).
 */
export function liveState({ enabled = true, authenticated = true, online = true, visible = true, lastInteractionAt = 0, now = 0, idleLimitMs = IDLE_LIMIT_MS } = {}) {
  if (!authenticated) return { active: false, state: 'signed_out' };
  if (!enabled) return { active: false, state: 'disabled' };
  if (!online) return { active: false, state: 'offline' };
  if (!visible) return { active: false, state: 'hidden' };
  if (now - lastInteractionAt >= idleLimitMs) return { active: false, state: 'idle' };
  return { active: true, state: 'live' };
}

/** Délai avant le passage en « inactif » (ms) ; ≤ 0 : déjà inactif. */
export const idleRemainingMs = (lastInteractionAt, now, idleLimitMs = IDLE_LIMIT_MS) => idleLimitMs - (now - lastInteractionAt);

// ---------------------------------------------------------------- Cadences
/** Intervalle de lecture de /live : 3 s ; 5 s si la mesure Dokploy est plus lente que 10 s ; plancher 2 s. */
export function infraIntervalMs(sampleIntervalSeconds) {
  const s = Number(sampleIntervalSeconds);
  const base = isNum(s) && s > 10 ? INFRA_SLOW_MS : INFRA_FAST_MS;
  return Math.max(INFRA_FLOOR_MS, base);
}

/** Intervalle des réseaux sociaux : 20 s ; 5 s tant que des blocs se chargent (borné dans le temps par l'appelant). */
export const socialIntervalMs = ({ loading = false } = {}) => (loading ? SOCIAL_FAST_MS : SOCIAL_MS);

/** Backoff exponentiel : base × 2^échecs, plafonné (3 → 6 → 12 → 24 → 30 s pour /live). 0 échec = la cadence normale. */
export function backoffMs(failures, baseMs, maxMs) {
  const f = Math.max(0, Math.floor(Number(failures) || 0));
  return Math.min(maxMs, baseMs * 2 ** f);
}

/** Retry-After (secondes ou date HTTP) → ms, borné [1 s ; 5 min] ; null si absent ou illisible. */
export function parseRetryAfter(value, now = Date.now()) {
  if (value === null || value === undefined || value === '') return null;
  const txt = String(value).trim();
  let ms = null;
  if (/^\d+(\.\d+)?$/.test(txt)) ms = Number(txt) * 1000;
  else { const t = Date.parse(txt); if (Number.isFinite(t)) ms = t - now; }
  if (ms === null || !Number.isFinite(ms)) return null;
  return Math.min(300_000, Math.max(1_000, Math.round(ms)));
}

/**
 * Délai avant la requête suivante d'une boucle.
 *   success  : cadence normale moins le temps déjà écoulé (jamais de chevauchement : on repart APRÈS la réponse ; réponse lente = tick sauté).
 *   failure  : backoff exponentiel ; un 429 respecte Retry-After (jamais en dessous du backoff).
 */
export function nextDelayMs({ ok, intervalMs, elapsedMs = 0, failures = 0, maxBackoffMs, retryAfterMs = null }) {
  if (ok) return Math.max(MIN_GAP_MS, intervalMs - Math.max(0, elapsedMs));
  const back = backoffMs(failures, intervalMs, maxBackoffMs);
  return retryAfterMs ? Math.max(back, retryAfterMs) : back;
}

/** Une boucle peut-elle lancer une requête maintenant ? (jamais deux en même temps, jamais hors actif) */
export const canStartRequest = ({ active, inflight, routeWants }) => Boolean(active && routeWants && !inflight);

/** Une erreur doit-elle arrêter le mode en direct ? 401 : oui (redirection vers la connexion). */
export const isFatalStatus = (status) => status === 401;

/** Quelles sources la route courante demande-t-elle ? (clé de route du routeur) */
export function routeNeeds(key) {
  const k = String(key || '');
  return {
    infra: k === 'overview' || k === 'infrastructure' || k === 'deployments',
    social: k === 'overview' || k === 'social' || k.startsWith('social/')
  };
}

// ---------------------------------------------------------------- Détection de nouveauté
/**
 * Jeton de version d'une réponse : updatedAt + heavyUpdatedAt + blocs en chargement (+ en-têtes X-Data-* pour /api/posts, tableau nu).
 * Retour null si la réponse ne porte aucune information de fraîcheur (comparaison par contenu, voir sameContent).
 */
export function dataToken(data, headers = null) {
  const h = (name) => (headers && typeof headers.get === 'function' ? headers.get(name) : headers && headers[name]) || null;
  const obj = data && typeof data === 'object' && !Array.isArray(data) ? data : null;
  const updated = (obj && obj.updatedAt) || h('X-Data-Updated-At') || null;
  const heavy = (obj && obj.heavyUpdatedAt) || null;
  const loading = obj && Array.isArray(obj.loading) ? obj.loading : (h('X-Data-Loading') || '').split(',').filter(Boolean);
  if (!updated && !heavy && !loading.length) return null;
  return `${updated || ''}|${heavy || ''}|${[...loading].sort().join(',')}`;
}

/** Contenu identique (réponses sans jeton) : comparaison JSON bornée. */
export const sameContent = (a, b) => { try { return JSON.stringify(a) === JSON.stringify(b); } catch (e) { return false; } };

/** Y a-t-il quelque chose de nouveau ? Jeton différent ; sans jeton, contenu différent. Premier chargement = nouveau. */
export function hasNewData(prev, next) {
  if (!prev) return true;
  const a = prev.token, b = next.token;
  if (a !== null && a !== undefined && b !== null && b !== undefined) return a !== b;
  return !sameContent(prev.data, next.data);
}

/** Des blocs sont-ils encore en chargement (réponse /stats, /overview préfixée, ou en-tête) ? */
export function isLoading(data, headers = null) {
  const h = headers && typeof headers.get === 'function' ? headers.get('X-Data-Loading') : null;
  return Boolean((data && Array.isArray(data.loading) && data.loading.length) || h);
}

/** Un bloc nommé est-il en chargement ? Accepte « audience » ou « instagram:audience ». */
export function blockLoading(data, block, platform = null) {
  const list = data && Array.isArray(data.loading) ? data.loading : [];
  return list.includes(block) || (platform ? list.includes(`${platform}:${block}`) : false);
}

// ---------------------------------------------------------------- Report du re-rendu
/**
 * Peut-on remplacer l'écran maintenant ? Retour { defer, reason }.
 * Reporte si : dialogue ouvert, focus dans un champ / sélecteur / tableau, texte sélectionné, défilement ou sélection dans les 3 dernières secondes.
 */
export function shouldDeferRender({ dialogOpen = false, focusInControl = false, hasSelection = false, lastScrollAt = 0, lastSelectionAt = 0, now = 0, settleMs = SETTLE_MS } = {}) {
  if (dialogOpen) return { defer: true, reason: 'dialog' };
  if (focusInControl) return { defer: true, reason: 'focus' };
  if (hasSelection) return { defer: true, reason: 'selection' };
  if (now - lastScrollAt < settleMs) return { defer: true, reason: 'scroll' };
  if (now - lastSelectionAt < settleMs) return { defer: true, reason: 'selection' };
  return { defer: false, reason: null };
}

/** « Nouvelles données disponibles — Actualiser » : report en cours depuis plus de 30 s. */
export const shouldOfferRefresh = (deferredSince, now, afterMs = REPORT_AFTER_MS) => deferredSince !== null && deferredSince !== undefined && now - deferredSince > afterMs;

/** L'élément actif est-il un contrôle en cours d'interaction ? (descripteur simple : tag, type, contentEditable, dans un tableau/filtre) */
export function isControlFocus(el) {
  if (!el) return false;
  const tag = String(el.tag || '').toLowerCase(), type = String(el.type || '').toLowerCase();
  if (tag === 'select' || tag === 'textarea') return true;
  if (tag === 'input') return !['button', 'submit', 'reset'].includes(type) || Boolean(el.inTable || el.inFilters);
  if (el.contentEditable) return true;
  return Boolean(el.inTable || el.inFilters);
}

// ---------------------------------------------------------------- Infrastructure : conversion et fusion
export const gibToBytes = (g) => (isNum(g) ? Math.round(g * GIB) : null);

const CONN_STATUS = new Set(['connected', 'error', 'not_configured']);

/**
 * Charge utile GET /api/infrastructure/live → contrat applyLive (js/features/infra-live.js).
 *  - GiB → octets (× 1024³) pour RAM et stockage ; pourcentages recalculés par le modèle d'affichage (octets utilisés ÷ total).
 *  - observedAt (heure de la MESURE) = server.sampleAt : l'âge affiché est celui de la donnée, pas celui de la lecture.
 *  - uptime et débits (Mbit/s) uniquement tels que fournis (null efface une valeur périmée, jamais inventé).
 *  - services : fusion par (type, id) dans la liste déjà chargée ; runningDeployments : « En cours » ; voir mergeServices / markRunning.
 */
export function liveToInfra(payload, { services = null, deployments = null } = {}) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const s = payload.server && typeof payload.server === 'object' ? payload.server : null;
  const out = {};
  const c = payload.connection && typeof payload.connection === 'object' ? payload.connection : null;
  if (c && CONN_STATUS.has(c.status)) {
    out.connection = { status: c.status, reason: c.reason ?? null, message: c.message ?? null };
    out.status = c.status;
  }
  if (s) {
    out.server = {
      status: s.status || 'unknown',
      reason: s.reason ?? null,
      message: s.message ?? null,
      observedAt: s.sampleAt || null,
      sampleAt: s.sampleAt || null,
      sampleAgeSeconds: isNum(s.sampleAgeSeconds) ? s.sampleAgeSeconds : null,
      sampleIntervalSeconds: isNum(s.sampleIntervalSeconds) ? s.sampleIntervalSeconds : null,
      cpuPercent: isNum(s.cpuPercent) ? s.cpuPercent : null,
      ramUsedBytes: gibToBytes(s.memoryUsedGiB),
      ramTotalBytes: gibToBytes(s.memoryTotalGiB),
      storageUsedBytes: gibToBytes(s.diskUsedGiB),
      storageTotalBytes: gibToBytes(s.diskTotalGiB),
      uptimeSeconds: isNum(s.uptimeSeconds) ? s.uptimeSeconds : null,
      networkInMbps: isNum(s.networkInMbps) ? s.networkInMbps : null,
      networkOutMbps: isNum(s.networkOutMbps) ? s.networkOutMbps : null,
      hint: typeof s.hint === 'string' && s.hint ? s.hint : null
    };
  }
  // Les listes ne sont incluses que si elles ont réellement changé : un tableau inchangé ne doit pas redessiner le tableau à l'écran.
  if (Array.isArray(payload.services) && Array.isArray(services)) { const m = mergeServices(services, payload.services); if (m !== services) out.services = m; }
  if (Array.isArray(payload.runningDeployments) && Array.isArray(deployments)) { const m = markRunning(deployments, payload.runningDeployments); if (m !== deployments) out.deployments = m; }
  return out;
}

/** Fusion par (type, id) : seul le statut est repris ; les autres champs (projet, actions, dernier déploiement…) sont conservés. Un statut vide ou « Indisponible » n'écrase rien. */
export function mergeServices(existing, live) {
  const status = new Map();
  for (const l of live || []) {
    if (!l || typeof l !== 'object' || !l.id || !l.type) continue;
    const st = typeof l.status === 'string' ? l.status.trim() : '';
    if (!st || st === 'Indisponible') continue;
    status.set(`${l.type}:${l.id}`, st);
  }
  let changed = false;
  const next = (existing || []).map((s) => {
    const st = status.get(`${s.type}:${s.id}`);
    if (st === undefined || st === s.status) return s;
    changed = true;
    return { ...s, status: st };
  });
  return changed ? next : existing;
}

/** Déploiements dont l'identifiant figure dans runningDeployments : statut « running » (En cours). Les autres sont inchangés (leur fin sera lue par le snapshot). */
export function markRunning(deployments, runningIds) {
  const run = new Set((runningIds || []).map(String));
  let changed = false;
  const next = (deployments || []).map((d) => {
    if (!run.has(String(d.id)) || d.status === 'running') return d;
    changed = true;
    return { ...d, status: 'running' };
  });
  return changed ? next : deployments;
}

/** Faut-il relire le snapshot complet ? changedAt a bougé (statuts / déploiements en cours), au plus une fois toutes les 15 s. */
export function needsSnapshot({ prevChangedAt, changedAt, lastSnapshotAt = 0, now = 0, minGapMs = SNAPSHOT_MIN_GAP_MS }) {
  if (!changedAt || changedAt === prevChangedAt) return false;
  if (prevChangedAt === undefined) return false; // première lecture : la page vient d'être rendue depuis le snapshot
  return now - lastSnapshotAt >= minGapMs;
}

// ---------------------------------------------------------------- Âge et libellés de l'indicateur
/** Âge lisible : « 4 s », « 3 min », « 2 h », « 3 j ». */
export function ageText(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} s`;
  if (s < 3600) return `${Math.floor(s / 60)} min`;
  if (s < 86400) return `${Math.floor(s / 3600)} h`;
  return `${Math.floor(s / 86400)} j`;
}

/**
 * Modèle de l'indicateur : { kind, text, action } avec kind ∈ live | refreshing | retry | paused | offline | cache | disabled | none.
 * L'âge est celui de la DONNÉE (dataAt = updatedAt / sampleAt), jamais celui du dernier ping.
 */
export function indicatorModel({ state, dataAt = null, now = 0, refreshing = false, stale = false, failing = false, route = '', hasLiveRoute = true }) {
  if (state === 'disabled') return { kind: 'disabled', text: 'Mode en direct désactivé', action: 'enable' };
  if (state === 'offline') return { kind: 'offline', text: 'Hors ligne', action: null };
  if (state === 'hidden') return { kind: 'paused', text: 'En pause — onglet masqué', action: 'resume' };
  if (state === 'idle') return { kind: 'paused', text: 'En pause (inactif)', action: 'resume' };
  if (state === 'signed_out') return { kind: 'none', text: '', action: null };
  if (!hasLiveRoute) return { kind: 'live', text: 'En direct', action: null };
  if (failing) return { kind: 'retry', text: 'Connexion instable — nouvelle tentative', action: null };
  const age = isNum(dataAt) ? now - dataAt : null;
  if (refreshing) return { kind: 'refreshing', text: 'Actualisation…', action: null };
  if (stale || (age !== null && age > CACHE_LABEL_AFTER_MS)) {
    const ms = age === null ? CACHE_LABEL_AFTER_MS : age;
    return { kind: 'cache', text: ms >= 60_000 ? `Données en cache (plus de ${ageText(ms)})` : 'Données en cache', action: null };
  }
  if (age === null) return { kind: 'live', text: 'En direct', action: null };
  return { kind: 'live', text: `En direct · mis à jour il y a ${ageText(age)}`, action: null };
}
