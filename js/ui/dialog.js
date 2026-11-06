/* Dialogues modaux accessibles (élément <dialog> natif : focus piégé, Échap, retour du focus au déclencheur). */
import { esc } from '../core/format.js?v=18';


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
