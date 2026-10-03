/* Suivi persistant d'un redéploiement / rechargement : bandeau indépendant des dialogues, repris après rechargement
   de la page via sessionStorage `sd.deploy`. Un seul suivi à la fois ; le bouton déclencheur reste inactif pendant le suivi. */
import { esc } from '../core/format.js?v=15';
import { statusLabel } from '../core/labels.js?v=15';
import { store } from '../core/state.js?v=15';
import { Live } from '../core/live.js?v=15';

const Api = window.Api;
export const title = 'Suivi des déploiements';
export const eyebrow = '';
export const render = () => ({ markup: '' });

const TRACK_KEY = 'sd.deploy';
const TERMINAL = ['done', 'error', 'cancelled', 'unknown'];
let tracker = null;
let onDone = () => {};

export const getTracker = () => tracker;
export const setTracker = (t) => { tracker = t; };
const $$ = (sel) => [...document.querySelectorAll(sel)];

export const saveTracker = () => {
  if (tracker && !tracker.done) store.sessionSet(TRACK_KEY, JSON.stringify({ operationId: tracker.operationId, name: tracker.name, context: tracker.context, serviceId: tracker.serviceId, startedAt: tracker.startedAt }));
  else store.sessionRemove(TRACK_KEY);
};

/** Redéploiement indisponible tant que le service tourne déjà un déploiement (statut running) ou qu'un suivi le concerne. */
export const trackerActiveFor = (id, name) => Boolean(tracker && !tracker.done && ((tracker.serviceId && tracker.serviceId === id) || (!tracker.serviceId && tracker.name === name)));
export const redeployBusy = (status, id, name) => status === 'running' || trackerActiveFor(id, name);

export function syncRedeployButtons() {
  $$('[data-redeploy],[data-reload]').forEach((b) => {
    const id = b.dataset.redeploy || b.dataset.reload;
    const busy = redeployBusy(b.dataset.status, id, b.dataset.serviceName);
    b.disabled = busy; b.textContent = busy ? 'En cours' : (b.hasAttribute('data-reload') ? 'Recharger' : 'Redéployer');
    if (busy) b.setAttribute('aria-disabled', 'true'); else b.removeAttribute('aria-disabled');
  });
}

export function showTracker() {
  let el = document.getElementById('deploy-tracker');
  if (!tracker) { if (el) el.remove(); syncRedeployButtons(); return; }
  if (!el) { el = document.createElement('div'); el.id = 'deploy-tracker'; el.className = 'tracker-wrap'; document.getElementById('notices').before(el); }
  const kind = tracker.done ? (tracker.status === 'done' ? 'ok' : 'err') : 'info';
  el.innerHTML = `<div class="notice notice--${kind}" role="status" aria-live="polite"><span><strong>${esc(tracker.name)}</strong>${tracker.context ? ` <small class="muted">(${esc(tracker.context)})</small>` : ''} : ${esc(tracker.message)}</span>${tracker.done ? '<div class="notice__actions"><button type="button" class="btn btn-ghost" data-tracker-close>Fermer</button></div>' : ''}</div>`;
  syncRedeployButtons();
}

export function focusTracker() { const el = document.getElementById('deploy-tracker'); if (el) { el.tabIndex = -1; el.focus({ preventScroll: true }); } }

export async function trackOperation(operationId, name, startedAt0 = Date.now(), serviceId = null, context = null, initial = 'Demande acceptée. Suivi du déploiement…') {
  let startedAt = startedAt0;
  tracker = { operationId, name, context, serviceId, startedAt, status: 'pending', message: initial, done: false };
  saveTracker(); showTracker();
  let failures = 0;
  while (tracker && tracker.operationId === operationId && !tracker.done) {
    await new Promise((resolve) => setTimeout(resolve, 4000));
    startedAt += await Live.waitUntilActive(); // onglet masqué / inactif / hors ligne : aucune requête, et le délai de 5 minutes ne court pas
    if (!tracker || tracker.operationId !== operationId) return;
    if (Date.now() - startedAt > 5 * 60000) { Object.assign(tracker, { done: true, status: 'unknown', message: 'Suivi expiré après cinq minutes. Vérifiez le résultat dans Dokploy.' }); break; }
    try {
      const status = await Api.getOperation(operationId); failures = 0;
      if (status.context) tracker.context = status.context;
      tracker.status = status.status; tracker.message = status.message || statusLabel(status.status);
      if (TERMINAL.includes(status.status)) tracker.done = true;
    } catch (err) {
      if (err && err.code === 'unauthenticated') return;
      if (err && err.status === 404) Object.assign(tracker, { done: true, status: 'unknown', message: err.message });
      else if (++failures >= 5) Object.assign(tracker, { done: true, status: 'unknown', message: 'Suivi interrompu : Dokploy ne répond pas. Consultez l’historique.' });
    }
    showTracker();
  }
  saveTracker(); showTracker();
  // Services et déploiements sont rafraîchis une fois le suivi terminé
  if (tracker && tracker.done) { Api.invalidate(); onDone(); }
}

/** Installe le bouton « Fermer » et reprend un suivi sauvegardé. `hooks.onDone` : rafraîchir la vue si elle concerne Dokploy. */
export function initTracker(hooks = {}) {
  onDone = hooks.onDone || onDone;
  document.addEventListener('click', (e) => {
    if (e.target.closest('[data-tracker-close]')) { tracker = null; saveTracker(); showTracker(); }
  });
  try {
    const saved = JSON.parse(store.sessionGet(TRACK_KEY) || 'null');
    if (saved && saved.operationId) trackOperation(saved.operationId, saved.name || 'Service', saved.startedAt || Date.now(), saved.serviceId || null, saved.context || null);
  } catch (e) { /* ignore */ }
}
