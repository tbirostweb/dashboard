/* Gestionnaire central du MODE EN DIRECT (un seul actif). Tant que l'application est réellement utilisée, il :
     1. signale la présence : POST /api/live/ping immédiatement puis toutes les 30 s ;
     2. rafraîchit Dokploy : GET /api/infrastructure/live toutes les 3 s (5 s si la mesure Dokploy est plus lente que 10 s) sur les pages qui affichent de l'infrastructure ;
     3. rafraîchit les réseaux sociaux : relecture des données (le backend sert son cache) toutes les 20 s sur les pages sociales, mise à jour de l'écran SANS perte d'état.
   « Actif » = utilisateur authentifié + onglet visible + en ligne + interaction dans les 5 dernières minutes + préférence activée.
   Sinon : arrêt TOTAL de toute requête périodique (timers effacés, requêtes en vol annulées) ; reprise = ping + rafraîchissement immédiats.
   Garde-fous : jamais deux requêtes simultanées par boucle (chaînes de setTimeout, pas de setInterval), AbortController à chaque changement de route,
   backoff exponentiel (3 → 6 → 12 → 30 s pour /live), Retry-After respecté sur 429, arrêt sur 401, LinkedIn jamais relancé automatiquement.
   La logique de décision est pure : js/core/live-logic.js. */
import {
  liveState, idleRemainingMs, infraIntervalMs, socialIntervalMs, nextDelayMs, parseRetryAfter, canStartRequest, routeNeeds, dataToken, hasNewData, isLoading,
  shouldDeferRender, shouldOfferRefresh, isControlFocus, liveToInfra, needsSnapshot, indicatorModel, isFatalStatus,
  PING_INTERVAL_MS, SOCIAL_MS, INFRA_BACKOFF_MAX_MS, SOCIAL_BACKOFF_MAX_MS, SNAPSHOT_MIN_GAP_MS
} from './live-logic.js?v=16';
import { store } from './state.js?v=16';
import { LiveIndicator } from '../ui/components.js?v=16';

const Api = window.Api;
const PREF_KEY = 'sd.live';
const FAST_WINDOW_MS = 2 * 60_000; // sondage rapproché (5 s) borné tant que des blocs « en chargement » sont annoncés par le backend
const now = () => Date.now();

/** Préférence « Mode en direct » (activé par défaut), persistée en localStorage (protégé par try/catch dans store). */
export const liveEnabled = () => store.get(PREF_KEY) !== '0';

const M = {
  hooks: { silentRender: async () => false, announce: () => {} },
  inited: false,
  route: { key: null, ready: false, needs: { infra: false, social: false }, applyLive: null, infraData: null, keys: [] },
  visible: true, online: true, authed: true,
  lastInteractionAt: now(), lastScrollAt: 0, lastSelectionAt: 0,
  state: 'live', active: false,
  timers: { ping: null, infra: null, data: null, tick: null, idle: null, apply: null },
  ctl: { ping: null, infra: null, data: null, snap: null },
  inflight: { ping: false, infra: false, data: false },
  fail: { ping: 0, infra: 0, data: 0 },
  retryNote: false,
  infraAt: null, infraStale: false, lastLive: null, snapChangedAt: undefined, lastSnapshotAt: 0, lastRecoverAt: 0,
  loadingSince: 0, busy: false,
  pending: false, deferredSince: null, waiters: []
};

// ---------------------------------------------------------------- Boucles (chaînes de setTimeout : jamais de chevauchement)
const wants = (name) => (name === 'ping' ? true : name === 'infra' ? M.route.needs.infra && M.route.ready && typeof M.route.applyLive === 'function' : M.route.needs.social && M.route.ready && M.route.keys.length > 0);

function schedule(name, delay) {
  clearTimeout(M.timers[name]); M.timers[name] = null;
  if (!M.active || !wants(name)) return;
  M.timers[name] = setTimeout(() => { M.timers[name] = null; step(name); }, Math.max(0, delay));
}

async function step(name) {
  if (!canStartRequest({ active: M.active && !Api.isRedirecting(), inflight: M.inflight[name], routeWants: wants(name) })) return;
  M.inflight[name] = true;
  const ctl = new AbortController(); M.ctl[name] = ctl;
  const t0 = now();
  let delay = null;
  try { delay = await RUN[name](ctl.signal, t0); } catch (err) { delay = onError(name, err, ctl.signal); } finally { if (M.ctl[name] === ctl) M.ctl[name] = null; M.inflight[name] = false; }
  M.retryNote = M.fail.infra >= 2 || M.fail.data >= 2;
  renderIndicator();
  if (ctl.signal.aborted || delay === null) return; // arrêt / changement de route : celui qui a annulé relance les boucles
  schedule(name, delay);
}

function onError(name, err, signal) {
  if (signal.aborted || (err && err.code === 'aborted')) return null;
  if (err && (isFatalStatus(err.status) || err.code === 'unauthenticated')) { M.authed = false; reconcile(); return null; }
  M.fail[name] += 1;
  const base = name === 'ping' ? PING_INTERVAL_MS : name === 'infra' ? infraIntervalMs(M.lastLive && M.lastLive.server && M.lastLive.server.sampleIntervalSeconds) : SOCIAL_MS;
  return nextDelayMs({ ok: false, intervalMs: base, failures: M.fail[name], maxBackoffMs: name === 'infra' ? INFRA_BACKOFF_MAX_MS : SOCIAL_BACKOFF_MAX_MS, retryAfterMs: err && err.status === 429 ? parseRetryAfter(err.retryAfter || (err.data && err.data.retryAfter)) : null });
}

const RUN = {
  async ping(signal) {
    await Api.livePing({ signal });
    M.fail.ping = 0;
    return PING_INTERVAL_MS;
  },

  async infra(signal, t0) {
    const payload = await Api.getInfrastructureLive({ signal });
    if (signal.aborted) return null;
    M.fail.infra = 0;
    applyInfraPayload(payload);
    return nextDelayMs({ ok: true, intervalMs: infraIntervalMs(payload && payload.server && payload.server.sampleIntervalSeconds), elapsedMs: now() - t0 });
  },

  async data(signal, t0) {
    const results = await Api.refetch(M.route.keys.filter((k) => Api.peek(k)), { signal }); // seules les lectures réussies sont sondées
    if (signal.aborted) return null;
    M.fail.data = 0;
    let changed = false;
    for (const r of results) if (differs(r)) changed = true;
    trackLoading();
    if (changed) markPending();
    renderIndicator();
    return nextDelayMs({ ok: true, intervalMs: socialIntervalMs({ loading: fastPolling() }), elapsedMs: now() - t0 });
  }
};

/** Une relecture apporte-t-elle du nouveau ? (updatedAt / heavyUpdatedAt / blocs en chargement, ou en-têtes X-Data-* pour /api/posts) */
function differs({ prev, next, error }) {
  if (error) return Boolean(prev); // une donnée affichée disparaît (déconnexion, jeton expiré) : le rendu affichera la carte d'erreur ; sans donnée affichée, rien à changer
  if (!next) return false;
  const p = prev ? { token: dataToken(prev.data, prev.headers), data: prev.data } : null;
  return hasNewData(p, { token: dataToken(next.data, next.headers), data: next.data });
}

// ---------------------------------------------------------------- Infrastructure : /live → applyLive
function applyInfraPayload(payload) {
  if (!payload || typeof payload !== 'object') return;
  M.lastLive = payload;
  const route = M.route, cur = route.infraData ? route.infraData() : null;
  const converted = liveToInfra(payload, { services: cur && cur.services, deployments: cur && cur.deployments });
  const applied = converted && typeof route.applyLive === 'function' ? route.applyLive(converted) : null;
  // La page a été rendue sans données Dokploy (injoignable au chargement) et l'API répond de nouveau : rendu silencieux, au plus toutes les 15 s.
  if (applied === false && converted.status === 'connected' && now() - M.lastRecoverAt > SNAPSHOT_MIN_GAP_MS) { M.lastRecoverAt = now(); markPending(); }
  const server = payload.server || {};
  const at = server.status === 'available' && server.sampleAt ? Date.parse(server.sampleAt) : Date.parse(payload.observedAt);
  M.infraStale = Boolean(payload.connection && payload.connection.status === 'error');
  if (!M.infraStale && Number.isFinite(at)) M.infraAt = at; // API injoignable : l'âge continue de croître (jamais rajeuni par la lecture)
  // Statuts ou déploiements en cours modifiés : le snapshot complet (dernier déploiement, historique) est relu, au plus toutes les 15 s.
  if (M.snapChangedAt === undefined) M.snapChangedAt = payload.changedAt ?? null;
  else if (needsSnapshot({ prevChangedAt: M.snapChangedAt, changedAt: payload.changedAt, lastSnapshotAt: M.lastSnapshotAt, now: now() })) {
    M.snapChangedAt = payload.changedAt; M.lastSnapshotAt = now(); refreshSnapshot();
  }
}

async function refreshSnapshot() {
  const routeKey = M.route.key;
  if (M.ctl.snap) M.ctl.snap.abort();
  const ctl = new AbortController(); M.ctl.snap = ctl;
  try {
    const snap = await Api.refreshInfrastructure({ signal: ctl.signal });
    if (ctl.signal.aborted || routeKey !== M.route.key || typeof M.route.applyLive !== 'function') return;
    M.route.applyLive(snap);
    // Les statuts « en direct » plus récents que le snapshot (cache serveur de 15 s) repassent par-dessus.
    if (M.lastLive) {
      const cur = M.route.infraData ? M.route.infraData() : null;
      const again = liveToInfra({ services: M.lastLive.services, runningDeployments: M.lastLive.runningDeployments }, { services: cur && cur.services, deployments: cur && cur.deployments });
      if (again && (again.services || again.deployments)) M.route.applyLive(again);
    }
  } catch (e) { /* le prochain changement relancera ; 401 : géré par Api */ } finally { if (M.ctl.snap === ctl) M.ctl.snap = null; }
}

// ---------------------------------------------------------------- Réseaux sociaux : mise à jour sans perte d'état
const entries = () => M.route.keys.map((k) => Api.peek(k)).filter(Boolean);
function trackLoading() {
  const loading = entries().some((e) => isLoading(e.data, e.headers));
  if (loading) { if (!M.loadingSince) M.loadingSince = now(); } else M.loadingSince = 0;
}
const fastPolling = () => M.loadingSince > 0 && now() - M.loadingSince < FAST_WINDOW_MS;

function domFacts() {
  const a = document.activeElement, content = document.getElementById('content');
  const inContent = a && a !== document.body && (a.closest('dialog') || (content && content.contains(a)));
  const desc = inContent ? { tag: a.tagName, type: a.type, contentEditable: a.isContentEditable, inTable: Boolean(a.closest('[data-dt]')), inFilters: Boolean(a.closest('.filters, [data-filter-form], .dt__bar, [role="search"]')) } : null;
  const sel = window.getSelection && window.getSelection();
  const hasSelection = Boolean(sel && !sel.isCollapsed && String(sel).trim() && content && sel.anchorNode && content.contains(sel.anchorNode));
  return { dialogOpen: Boolean(document.querySelector('dialog[open]')), focusInControl: isControlFocus(desc), hasSelection, lastScrollAt: M.lastScrollAt, lastSelectionAt: M.lastSelectionAt, now: now() };
}

function markPending() {
  M.pending = true;
  tryApply();
}

/** Applique la mise à jour en attente dès que l'écran n'est plus en cours d'interaction ; sinon reporte (re-test chaque seconde, bouton après 30 s). */
async function tryApply() {
  clearTimeout(M.timers.apply); M.timers.apply = null;
  if (!M.pending || !M.route.ready) return;
  const d = shouldDeferRender(domFacts());
  if (d.defer) {
    if (M.deferredSince === null) M.deferredSince = now();
    if (M.active) M.timers.apply = setTimeout(tryApply, 1000);
    renderIndicator();
    return;
  }
  M.pending = false; M.deferredSince = null;
  await M.hooks.silentRender();
  trackLoading();
  renderIndicator();
}

// ---------------------------------------------------------------- Indicateur (en-tête)
const dataTimes = () => {
  const t = [];
  if (M.route.needs.infra && M.infraAt) t.push({ at: M.infraAt, stale: M.infraStale });
  if (M.route.needs.social) for (const e of entries()) {
    const iso = (e.data && !Array.isArray(e.data) && e.data.updatedAt) || (e.headers && e.headers['X-Data-Updated-At']);
    const at = iso ? Date.parse(iso) : NaN;
    if (Number.isFinite(at)) t.push({ at, stale: Boolean((e.data && e.data.stale === true) || (e.headers && e.headers['X-Data-Stale'] === 'true')) });
  }
  return t;
};

function renderIndicator() {
  const el = document.getElementById('live-indicator'); if (!el) return;
  const times = dataTimes();
  const refreshing = M.busy || (M.route.needs.social && entries().some((e) => (e.data && e.data.refreshing === true) || (e.headers && e.headers['X-Data-Refreshing'] === 'true')));
  const model = indicatorModel({
    state: M.state, dataAt: times.length ? Math.max(...times.map((x) => x.at)) : null, now: now(), refreshing,
    stale: times.length > 0 && times.every((x) => x.stale), failing: M.retryNote,
    hasLiveRoute: M.route.needs.infra || M.route.needs.social
  });
  const offer = M.deferredSince !== null && shouldOfferRefresh(M.deferredSince, now());
  const sig = `${model.kind}|${model.action}|${offer}`;
  if (el._sig !== sig) { el._sig = sig; el.innerHTML = model.kind === 'none' ? '' : LiveIndicator({ kind: model.kind, text: model.text, action: model.action, offerRefresh: offer }); el._text = model.text; return; }
  const txt = el.querySelector('[data-live-text]');
  if (txt && el._text !== model.text) { el._text = model.text; txt.textContent = model.text; }
}

// ---------------------------------------------------------------- Présence et état global
function stopAll() {
  for (const k of Object.keys(M.timers)) { clearTimeout(M.timers[k]); clearInterval(M.timers[k]); M.timers[k] = null; }
  for (const k of Object.keys(M.ctl)) { if (M.ctl[k]) M.ctl[k].abort(); M.ctl[k] = null; }
  M.inflight.ping = M.inflight.infra = M.inflight.data = false;
}

function armIdle() {
  clearTimeout(M.timers.idle); M.timers.idle = null;
  if (!M.active) return;
  M.timers.idle = setTimeout(() => { M.timers.idle = null; reconcile(); }, Math.max(250, idleRemainingMs(M.lastInteractionAt, now())) + 50);
}

function startLoops() {
  for (const name of ['ping', 'infra', 'data']) if (!M.timers[name] && !M.inflight[name]) schedule(name, 0);
  if (!M.timers.tick) M.timers.tick = setInterval(renderIndicator, 1000);
  armIdle();
}

const SAY = { idle: 'Mode en direct en pause : aucune activité.', offline: 'Hors ligne : mode en direct en pause.', live: 'Mode en direct actif.', disabled: 'Mode en direct désactivé.' };

/** Recalcule l'état et démarre / arrête toutes les boucles. Appelé à chaque événement qui peut le changer. */
export function reconcile() {
  const s = liveState({ enabled: liveEnabled(), authenticated: M.authed && !Api.isRedirecting(), online: M.online, visible: M.visible, lastInteractionAt: M.lastInteractionAt, now: now() });
  const was = M.state, wasActive = M.active;
  M.state = s.state; M.active = s.active;
  if (s.active) {
    if (!wasActive) { M.fail.ping = M.fail.infra = M.fail.data = 0; M.retryNote = false; }
    startLoops();
    if (!wasActive && M.pending) tryApply();
  } else { stopAll(); M.retryNote = false; }
  if (M.inited && was !== M.state && M.state !== 'hidden' && was !== 'hidden' && SAY[M.state]) M.hooks.announce(SAY[M.state]);
  renderIndicator();
  if (M.state === 'live' || M.state === 'disabled') { const w = M.waiters.splice(0); w.forEach((fn) => fn()); }
}

// ---------------------------------------------------------------- Intégration routeur
export const Live = {
  /** Installe les écouteurs (une seule fois) ; hooks : { silentRender, announce }. */
  init(hooks = {}) {
    if (M.inited) return;
    M.hooks = { ...M.hooks, ...hooks };
    M.visible = document.visibilityState !== 'hidden'; M.online = navigator.onLine !== false;
    const touch = () => { M.lastInteractionAt = now(); if (M.state === 'idle') reconcile(); else if (M.active && !M.timers.idle) armIdle(); };
    for (const ev of ['pointerdown', 'pointermove', 'keydown', 'wheel', 'touchstart']) window.addEventListener(ev, touch, { passive: true, capture: true });
    window.addEventListener('scroll', () => { M.lastScrollAt = now(); touch(); }, { passive: true, capture: true });
    document.addEventListener('selectionchange', () => { const sel = window.getSelection(); if (sel && !sel.isCollapsed) M.lastSelectionAt = now(); });
    document.addEventListener('visibilitychange', () => { M.visible = document.visibilityState !== 'hidden'; if (M.visible) M.lastInteractionAt = now(); reconcile(); });
    window.addEventListener('online', () => { M.online = true; reconcile(); });
    window.addEventListener('offline', () => { M.online = false; reconcile(); });
    window.addEventListener('pagehide', () => { M.visible = false; stopAll(); M.active = false; });
    window.addEventListener('pageshow', (e) => { if (e.persisted) { M.visible = document.visibilityState !== 'hidden'; M.lastInteractionAt = now(); reconcile(); } });
    document.addEventListener('focusout', () => { if (M.pending) setTimeout(tryApply, 50); });
    document.addEventListener('close', () => { if (M.pending) setTimeout(tryApply, 50); }, true);
    document.addEventListener('click', (e) => {
      const act = e.target.closest && e.target.closest('[data-live-action]');
      if (act) { if (act.dataset.liveAction === 'enable') Live.setEnabled(true); else { M.lastInteractionAt = now(); M.visible = document.visibilityState !== 'hidden'; reconcile(); } return; }
      if (e.target.closest && e.target.closest('[data-live-apply]')) { M.deferredSince = null; M.pending = false; M.hooks.silentRender(true).then(renderIndicator); }
    });
    document.addEventListener('change', (e) => { const t = e.target.closest && e.target.closest('[data-live-pref]'); if (t) Live.setEnabled(t.checked); });
    M.inited = true;
    reconcile();
  },

  /** Début d'un rendu de page (navigation, période, actualisation) : annule tout ce qui concernait la page précédente. */
  routeChanged(key) {
    for (const k of ['infra', 'data', 'snap']) { clearTimeout(M.timers[k]); M.timers[k] = null; if (M.ctl[k]) { M.ctl[k].abort(); M.ctl[k] = null; } M.inflight[k] = false; }
    clearTimeout(M.timers.apply); M.timers.apply = null;
    Object.assign(M.route, { key, ready: false, needs: routeNeeds(key), applyLive: null, infraData: null, keys: [] });
    Object.assign(M, { pending: false, deferredSince: null, loadingSince: 0, snapChangedAt: undefined, lastLive: null, infraAt: null, infraStale: false });
    M.fail.infra = M.fail.data = 0; M.retryNote = false;
    renderIndicator();
  },

  /** Page rendue : result.applyLive / result.infraData (infrastructure), keys = clés de données lues pendant le rendu. */
  routeReady(key, { result = {}, keys = [] } = {}) {
    if (key !== M.route.key) return;
    Object.assign(M.route, { ready: true, applyLive: typeof result.applyLive === 'function' ? result.applyLive : null, infraData: typeof result.infraData === 'function' ? result.infraData : null, keys });
    trackLoading();
    if (M.active) for (const name of ['infra', 'data']) if (!M.timers[name] && !M.inflight[name] && wants(name)) schedule(name, name === 'infra' ? 0 : fastPolling() ? 0 : SOCIAL_MS);
    renderIndicator();
  },

  /** Rendu silencieux terminé (nouvelles clés et applyLive éventuellement renouvelés). */
  silentDone(key, { result = {}, keys = [] } = {}) {
    if (key !== M.route.key) return;
    M.route.applyLive = typeof result.applyLive === 'function' ? result.applyLive : M.route.applyLive;
    M.route.infraData = typeof result.infraData === 'function' ? result.infraData : M.route.infraData;
    if (keys.length) M.route.keys = keys;
  },

  /** Une relecture de fond (stale-while-revalidate) a abouti : y a-t-il du nouveau pour la page affichée ? */
  onBackgroundData(info) {
    if (!M.route.ready) return;
    if (info.path === '/infrastructure') {
      if (M.route.needs.infra && info.next && typeof M.route.applyLive === 'function') M.route.applyLive(info.next.data);
      return;
    }
    if (M.route.keys.includes(info.key) && differs(info)) { trackLoading(); markPending(); }
  },

  /** Actualisation manuelle en cours (bouton Actualiser) : « Actualisation… » dans l'indicateur. */
  setBusy(on) { M.busy = Boolean(on); renderIndicator(); },

  setEnabled(on) { store.set(PREF_KEY, on ? '1' : '0'); document.querySelectorAll('[data-live-pref]').forEach((c) => { c.checked = on; }); if (on) M.lastInteractionAt = now(); reconcile(); },
  reconcile,
  tryApply,

  /**
   * Pour les suivis demandés par l'utilisateur (redéploiement) : attend que l'onglet soit visible, en ligne et utilisé (ou que le mode en direct soit
   * désactivé : le suivi d'une opération lancée par l'utilisateur ne dépend pas de la préférence). Renvoie la durée d'attente en ms.
   * Aucune requête périodique ne part tant que l'onglet est masqué, inactif ou hors ligne.
   */
  waitUntilActive() {
    const t0 = now();
    if (!M.inited || M.state === 'live' || M.state === 'disabled' || M.state === 'signed_out') return Promise.resolve(0);
    return new Promise((resolve) => M.waiters.push(() => resolve(now() - t0)));
  },

  /** Instantané de diagnostic (tests de fuite : minuteries et requêtes actives). Aucune donnée de compte. */
  snapshot() {
    return {
      state: M.state, active: M.active, route: M.route.key, ready: M.route.ready, pending: M.pending, deferredSince: M.deferredSince,
      timers: Object.fromEntries(Object.entries(M.timers).map(([k, v]) => [k, Boolean(v)])), inflight: { ...M.inflight },
      fail: { ...M.fail }, keys: M.route.keys.length
    };
  }
};
window.__sdLive = { snapshot: Live.snapshot, reconcile };
