/* Dialogues modaux accessibles (élément <dialog> natif : focus piégé, Échap, retour du focus au déclencheur). */
import { esc } from '../core/format.js?v=16';
import { getTracker, setTracker, saveTracker, showTracker, focusTracker, trackOperation } from '../features/deploy-tracker.js?v=16';

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
  // Second facteur : un code TOTP frais est exigé par le serveur pour chaque action d'infrastructure.
  const totpField = '<div class="field dialog-totp"><label for="dialog-totp">Code de vérification (application d’authentification)</label><input id="dialog-totp" name="totp" type="text" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" maxlength="6" required aria-describedby="dialog-totp-help"><p class="muted" id="dialog-totp-help">6 chiffres ; chaque code n’est utilisable qu’une fois.</p></div>';
  const dialog = openDialog(cfg.title, `${cfg.text}${totpField}${active ? `<p class="muted">Un suivi est déjà en cours pour ${esc(tracker.name)}${tracker.context ? ` (${esc(tracker.context)})` : ''} (voir le bandeau).</p>` : ''}`,
    `<div class="dialog-actions"><button type="button" class="btn btn-ghost" data-cancel>Annuler</button><button type="button" class="btn btn-accent" data-confirm>${esc(cfg.confirm)}</button></div><p class="operation-status" role="status" aria-live="polite"></p>`);
  dialog.querySelector('[data-cancel]').onclick = () => dialog.close();
  let sent = false;
  const codeInput = dialog.querySelector('#dialog-totp');
  codeInput.focus();
  codeInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); dialog.querySelector('[data-confirm]').click(); } });
  dialog.querySelector('[data-confirm]').onclick = async () => {
    if (sent) return;
    const confirm = dialog.querySelector('[data-confirm]'), cancel = dialog.querySelector('[data-cancel]'), result = dialog.querySelector('.operation-status');
    const code = codeInput.value.trim();
    if (!/^\d{6}$/.test(code)) { result.textContent = 'Saisissez le code à 6 chiffres.'; codeInput.setAttribute('aria-invalid', 'true'); codeInput.focus(); return; }
    sent = true;
    confirm.disabled = true; cancel.disabled = true; codeInput.disabled = true; result.textContent = 'Envoi de la demande…';
    const name = button.dataset.serviceName, id = cfg.id, context = button.dataset.serviceContext || null;
    try {
      const operation = await cfg.run(code);
      dialog.close(); // le bandeau de suivi prend le relais, sans doublon
      Api.invalidate();
      trackOperation(operation.operationId, name, Date.now(), id, operation.context || context, cfg.initial);
      focusTracker(); // le bouton déclencheur devient inactif : le focus passe au bandeau de suivi
    } catch (err) {
      if (err && err.code === 'unauthenticated') { dialog.close(); return; }
      // Code refusé (faux, déjà utilisé) : le dialogue reste ouvert pour une nouvelle saisie, sans doublon de requête.
      if (err && ['second_factor_required', 'second_factor_invalid', 'totp_replay'].includes(err.code)) {
        sent = false; confirm.disabled = false; cancel.disabled = false; codeInput.disabled = false; codeInput.value = '';
        codeInput.setAttribute('aria-invalid', 'true'); result.textContent = err.message; codeInput.focus();
        return;
      }
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
