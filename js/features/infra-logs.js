/* Journaux de déploiement : lien Dokploy validé + panneau latéral (dialog large) avec Copier / Réessayer.
   États explicites : available · filtered · unsupported · permission · empty · temporary (+ chargement).
   Attributs délégués conservés : data-logs (ouverture, dans infra-shared), data-logs-retry (ici). */
import { esc } from '../core/format.js?v=15';
import { StatusBadge } from '../ui/components.js?v=15';
import { openDialog } from '../ui/dialog.js?v=15';

const Api = window.Api;

const VALID_PATH = /^\/dashboard\/project\/[^/]+\/environment\/[^/]+\/services\/[^/]+\/[^/]+$/;
/** URL projetée et validée côté backend ; on la revalide ici (http/https, sans identifiants, chemin attendu, aucune requête hors ?tab=deployments, aucun fragment). */
export function isDokployUrl(url) {
  if (!url) return false;
  try {
    const u = new URL(url);
    if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password || (u.search && u.search !== '?tab=deployments') || u.hash || !VALID_PATH.test(u.pathname)) return false;
    return true;
  } catch { return false; }
}
/** dokployLink(url, context, className?) → lien externe (HTML) ou '' si l'URL est invalide. */
export function dokployLink(url, context, className = 'btn btn-quiet btn-small') {
  if (!isDokployUrl(url)) return '';
  return `<a class="${esc(className)}" href="${esc(url)}" target="_blank" rel="noopener noreferrer" aria-label="Voir dans Dokploy : ${esc(context || 'Service')} (ouvre dans un nouvel onglet)">Voir dans Dokploy ↗</a>`;
}

const STATE_BADGE = {
  loading: { kind: 'pending', label: 'Chargement…' },
  available: { kind: 'ok', label: 'Journal disponible' },
  filtered: { kind: 'warn', label: 'Contenu filtré' },
  unsupported: { kind: 'info', label: 'Non supporté par cette version' },
  permission: { kind: 'error', label: 'Permission insuffisante' },
  empty: { kind: 'neutral', label: 'Journal vide' },
  temporary: { kind: 'warn', label: 'Erreur temporaire' }
};

function setState(dialog, key, announce) {
  const b = STATE_BADGE[key] || STATE_BADGE.temporary;
  dialog.querySelector('[data-logs-state]').innerHTML = StatusBadge(b);
  const copy = dialog.querySelector('[data-logs-copy]');
  if (copy) copy.disabled = !(key === 'available' || key === 'filtered');
  const live = dialog.querySelector('[data-logs-announce]');
  if (live && announce) { live.textContent = ''; setTimeout(() => { live.textContent = announce; }, 30); }
}

async function loadLogs(dialog, id) {
  const body = dialog.querySelector('[data-logs-body]');
  body.setAttribute('aria-busy', 'true');
  body.innerHTML = '<p class="muted">Chargement du journal…</p>';
  setState(dialog, 'loading', 'Chargement du journal.');
  const retry = '<p><button type="button" class="btn btn-ghost btn-small" data-logs-retry>Réessayer</button></p>';
  try {
    const d = await Api.getDeploymentLogs(id);
    if (!dialog.isConnected) return;
    const external = dokployLink(d.dokployUrl, d.context, 'btn btn-ghost btn-small');
    const externalNote = external ? `<p class="infra-note">${external}</p><p class="muted">Dans le service Dokploy, ouvrez la section Déploiements puis le journal concerné.</p>` : '';
    if (d.state === 'available' && d.available) {
      const note = d.filtered
        ? `Contenu disponible mais filtré : des éléments sensibles ont pu être masqués${d.truncated ? ' et le journal a été tronqué aux 200 dernières lignes' : ''}. Consultez Dokploy pour le détail.`
        : 'Journaux expurgés automatiquement (secrets masqués, 200 dernières lignes au plus) ; ils peuvent rester incomplets. Consultez Dokploy pour le détail.';
      const lines = String(d.logs || '').split('\n').length;
      body.innerHTML = `<p class="muted">${d.source === 'dokploy_websocket' || d.transport === 'websocket' ? 'Source : flux officiel Dokploy.' : 'Source : API Dokploy.'}</p><p class="muted infra-note">${esc(note)}</p><pre class="deployment-logs" tabindex="0" aria-label="Contenu du journal">${esc(d.logs || '')}</pre>`;
      setState(dialog, d.filtered ? 'filtered' : 'available', `Journal chargé, ${lines} lignes.`);
    } else if (d.state === 'unsupported') {
      body.innerHTML = `<p><strong>Fonctionnalité absente.</strong></p><p class="muted">${esc(d.message || 'Cette version de Dokploy ne fournit pas la lecture des journaux via l’API. Consultez-les dans Dokploy.')}</p>`;
      setState(dialog, 'unsupported', 'Lecture des journaux non supportée par cette version de Dokploy.');
    } else if (d.state === 'permission') {
      body.innerHTML = `<p><strong>Permission insuffisante.</strong></p><p class="muted">${esc(d.message || 'La clé API ne permet pas de lire ce journal.')}</p>`;
      setState(dialog, 'permission', 'Permission insuffisante pour lire ce journal.');
    } else if (d.state === 'empty') {
      body.innerHTML = `<p><strong>Journal vide.</strong></p><p class="muted">${esc(d.message || 'Aucun contenu à afficher pour ce déploiement.')}</p>`;
      setState(dialog, 'empty', 'Le journal est vide.');
    } else {
      body.innerHTML = `<p><strong>Erreur temporaire.</strong></p><p class="muted">${esc(d.message || 'Lecture des journaux momentanément impossible.')}</p>${retry}`;
      setState(dialog, 'temporary', 'Erreur temporaire de lecture du journal.');
    }
    if (!d.available && externalNote) body.innerHTML += externalNote;
  } catch (err) {
    if (!dialog.isConnected || (err && err.code === 'unauthenticated')) return;
    body.innerHTML = `<p><strong>Erreur temporaire.</strong></p><p class="muted">${esc((err && err.message) || 'Lecture des journaux momentanément impossible.')}</p>${retry}`;
    setState(dialog, 'temporary', 'Erreur temporaire de lecture du journal.');
  } finally { body.removeAttribute('aria-busy'); }
}

async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch (e) { /* repli ci-dessous */ }
  try {
    const ta = Object.assign(document.createElement('textarea'), { value: text });
    ta.setAttribute('readonly', ''); ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.append(ta); ta.select();
    const ok = document.execCommand('copy'); ta.remove(); return ok;
  } catch (e) { return false; }
}

/** Ouvre le panneau latéral des journaux d'un déploiement. */
export function openLogs(id, context) {
  const dialog = openDialog('Journaux de déploiement', `<p class="ctx-line">${esc(context || 'Projet inconnu → Environnement inconnu → Service inconnu')}</p>
    <div class="logs-bar"><span data-logs-state></span><div class="btn-group" role="group" aria-label="Actions sur le journal"><button type="button" class="btn btn-ghost btn-small" data-logs-copy disabled>Copier</button><button type="button" class="btn btn-ghost btn-small" data-logs-retry>Réessayer</button></div></div>
    <p class="sr-only" role="status" aria-live="polite" data-logs-announce></p>
    <div data-logs-body></div>`);
  dialog.classList.add('dashboard-dialog--side');
  dialog.addEventListener('click', async (ev) => {
    if (ev.target.closest('[data-logs-retry]')) { loadLogs(dialog, id); return; }
    if (ev.target.closest('[data-logs-copy]')) {
      const pre = dialog.querySelector('.deployment-logs'); if (!pre) return;
      const ok = await copyText(pre.textContent);
      const live = dialog.querySelector('[data-logs-announce]');
      live.textContent = ''; setTimeout(() => { live.textContent = ok ? `Journal copié (${pre.textContent.split('\n').length} lignes).` : 'Copie impossible : sélectionnez le texte manuellement.'; }, 30);
      const btn = dialog.querySelector('[data-logs-copy]'); const label = btn.textContent;
      btn.textContent = ok ? 'Copié' : 'Échec de la copie'; setTimeout(() => { if (btn.isConnected) btn.textContent = label; }, 2000);
    }
  });
  loadLogs(dialog, id);
  return dialog;
}
