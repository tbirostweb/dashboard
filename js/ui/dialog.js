/* Dialogues modaux accessibles (élément <dialog> natif : focus piégé, Échap, retour du focus au déclencheur). */
import { esc } from '../core/format.js?v=17';
import { getTracker, setTracker, saveTracker, showTracker, focusTracker, trackOperation } from '../features/deploy-tracker.js?v=17';

const Api = window.Api;

/** openDialog(title, bodyHtml, actionsHtml?) → <dialog>. title est échappé ; body/actions = HTML de confiance. */
export function openDialog(title, body, actions = '') {
  const opener = document.activeElement;
  const dialog = document.createElement('dialog');
  dialog.className = 'dashboard-dialog';
  dialog.setAttribute('aria-modal', 'true');
  dialog.setAttribute('aria-labelledby', 'dialog-title');
  dialog.innerHTML = `<div class="dialog-heading"><h2 id="dialog-title">${esc(title)}</h2><button type="button" class="btn btn-ghost btn-small" data-close aria-label="Fermer">Fermer</button></div>${body}${actions}`;
  document.body.append(dialog);
  dialog.querySelector('[data-close]').onclick = () => dialog.close();
  dialog.addEventListener('close', () => { dialog.remove(); if (opener && opener.isConnected && typeof opener.focus === 'function' && !opener.disabled) opener.focus(); });
  dialog.showModal();
  return dialog;
}

/**
 * confirmAction(button, {title, confirm, id, text, run, initial, failure}) : confirmation commune (redéploiement, rechargement).
 * Une seule requête par confirmation (anti-doublon) ; le suivi prend ensuite le relais dans le bandeau persistant.
 */
export function confirmAction(button, cfg) {
  const tracker = getTracker();
  const active = tracker && !tracker.done;
  const dialog = openDialog(cfg.title, `${cfg.text}${active ? `<p class="muted">Un suivi est déjà en cours pour ${esc(tracker.name)}${tracker.context ? ` (${esc(tracker.context)})` : ''} (voir le bandeau).</p>` : ''}`,
    `<div class="dialog-actions"><button type="button" class="btn btn-ghost" data-cancel>Annuler</button><button type="button" class="btn btn-accent" data-confirm>${esc(cfg.confirm)}</button></div><p class="operation-status" role="status" aria-live="polite"></p>`);
  dialog.querySelector('[data-cancel]').onclick = () => dialog.close();
  let sent = false;
  dialog.querySelector('[data-confirm]').focus();
  dialog.querySelector('[data-confirm]').onclick = async () => {
    if (sent) return;
    const confirm = dialog.querySelector('[data-confirm]'), cancel = dialog.querySelector('[data-cancel]'), result = dialog.querySelector('.operation-status');
    sent = true;
    confirm.disabled = true; cancel.disabled = true; result.textContent = 'Envoi de la demande…';
    const name = button.dataset.serviceName, id = cfg.id, context = button.dataset.serviceContext || null;
    try {
      const operation = await cfg.run();
      dialog.close(); // le bandeau de suivi prend le relais, sans doublon
      Api.invalidate();
      trackOperation(operation.operationId, name, Date.now(), id, operation.context || context, cfg.initial);
      focusTracker(); // le bouton déclencheur devient inactif : le focus passe au bandeau de suivi
    } catch (err) {
      if (err && err.code === 'unauthenticated') { dialog.close(); return; }
      dialog.close();
      setTracker({ operationId: null, name, context, serviceId: id, startedAt: Date.now(), status: 'error', message: (err && err.message) || cfg.failure, done: true });
      saveTracker(); showTracker(); focusTracker();
    }
  };
  return dialog;
}

/**
 * confirmDialog({title, text (HTML de confiance), confirm, danger}) → Promise<boolean> : confirmation simple (sans suivi d'opération), annulable (Annuler, Fermer, Échap).
 * Le focus revient au déclencheur à la fermeture (openDialog).
 */
export function confirmDialog({ title, text = '', confirm = 'Confirmer', danger = false } = {}) {
  return new Promise((resolve) => {
    let answer = false;
    const dialog = openDialog(title, text, `<div class="dialog-actions"><button type="button" class="btn btn-ghost" data-cancel>Annuler</button><button type="button" class="btn ${danger ? 'btn-danger' : 'btn-accent'}" data-confirm>${esc(confirm)}</button></div>`);
    dialog.querySelector('[data-cancel]').onclick = () => dialog.close();
    dialog.querySelector('[data-confirm]').onclick = () => { answer = true; dialog.close(); };
    dialog.addEventListener('close', () => resolve(answer), { once: true });
  });
}
