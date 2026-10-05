/* Connexions aux plateformes : UNE alerte compacte (action requise) + pied de page minimal, retour OAuth, déconnexion.
   Service partagé par le routeur ; connectionsCard() restitue la section « Connexions sociales » de la page Paramètres. */
import { esc, fmtDateTime, relTime } from '../core/format.js?v=17';
import { PLATFORMS, PLATFORM_LABELS as LABELS, REASONS, statusLabel, statusKind, TOKEN_TEXT } from '../core/labels.js?v=17';
import { platformBadge, PLATFORM_ICONS, ICON, STATUS_ICONS } from '../ui/icons.js?v=17';
import { StatusBadge, SectionHeader, DataTable, Alert, ButtonGroup } from '../ui/components.js?v=17';
import { confirmDialog } from '../ui/dialog.js?v=17';
import { state } from '../core/state.js?v=17';
import { tokenView, connectionAlerts, actionableAlerts, renewOutcome, refreshOutcome, countdownText } from '../core/token-logic.js?v=17';

const Api = window.Api;
export const title = 'Connexions';
export const eyebrow = '';

export const flash = [];
export const connectBtn = (p, label = `Connecter ${LABELS[p]}`) => `<a class="btn btn-accent" href="${esc(Api.connectUrl(p))}">${esc(label)}</a>`;

/** Retour d'OAuth : ?connected=tiktok ou ?oauth_error=tiktok&reason=… */
export function readOAuthReturn() {
  const q = new URLSearchParams(location.search);
  const ok = q.get('connected'), ko = q.get('oauth_error');
  if (ok && LABELS[ok]) flash.push({ kind: 'ok', html: `${platformBadge(ok)} Compte ${esc(LABELS[ok])} connecté.` });
  if (ko && LABELS[ko]) flash.push({ kind: 'err', html: `${platformBadge(ko)} Connexion ${esc(LABELS[ko])} impossible : ${esc(REASONS[q.get('reason')] || 'erreur inconnue')}.` });
  if (ok || ko) history.replaceState(null, '', location.pathname + location.hash);
}

/** Carte d'erreur par plateforme (non connecté, expiré, en attente d'approbation) ou erreur générique. */
export function errorCard(err) {
  const p = err && err.platform;
  if (p && err.code === 'pending_approval') {
    return `<section class="card connect-card" aria-labelledby="cc-title">${platformBadge(p)}
      <h2 class="card__title" id="cc-title">En attente d'approbation LinkedIn</h2>
      <p>${esc(err.message)} Aucune statistique n'est affichée pour LinkedIn en attendant.</p>
      ${err.data && err.data.steps && err.data.steps.length ? `<h3 class="steps__title">Ce qu'il reste à faire</h3><ol class="steps">${err.data.steps.map((x) => `<li>${esc(x)}</li>`).join('')}</ol>` : ''}</section>`;
  }
  if (p && err.code === 'not_connected') {
    const configured = !(err.data && err.data.configured === false);
    return `<section class="card connect-card" aria-labelledby="cc-title">${platformBadge(p)}
      <h2 class="card__title" id="cc-title">${esc(LABELS[p])} n'est pas connecté</h2>
      <p>Reliez le compte pour afficher ses statistiques.${configured ? '' : ' Les identifiants de l’application ne sont pas encore renseignés sur le serveur (voir <code>connexion.md</code>).'}</p>
      ${connectBtn(p)}</section>`;
  }
  if (p && (err.code === 'token_expired' || err.code === 'provider_error')) {
    return `<section class="card connect-card" aria-labelledby="cc-title">${platformBadge(p)}
      <h2 class="card__title" id="cc-title">${err.code === 'token_expired' ? 'Connexion expirée' : 'Erreur de la plateforme'}</h2>
      <p>${esc(err.message)}</p>${connectBtn(p, `Reconnecter ${LABELS[p]}`)}</section>`;
  }
  const msg = err && err.code === 'network' ? err.message : `Impossible de charger les données : ${err && err.message ? err.message : 'erreur inconnue'}`;
  return `<div class="card"><p class="empty">${esc(msg)}</p></div>`;
}

// ---- Alertes : UNIQUEMENT reconnexion à prévoir / nécessaire (jamais l'échéance du jeton d'accès renouvelé automatiquement) ----
const reconnectLink = (a) => `<a class="btn btn-accent btn-small" href="${esc(a.reconnectPath)}" aria-label="Reconnecter ${esc(LABELS[a.platform])}">Reconnecter<span class="sr-only"> ${esc(LABELS[a.platform])}</span></a>`;
function alertOf(alerts, { withActions = false } = {}) {
  if (!alerts.length) return '';
  const kind = alerts.some((a) => a.kind === 'error') ? 'error' : 'warn';
  return Alert({ kind, title: kind === 'error' ? 'Action requise' : 'Reconnexion à prévoir',
    html: alerts.map((a) => `<span class="nowrap">${esc(a.text)}</span>`).join(' ; ') + '.',
    actions: withActions ? `${alerts.map(reconnectLink).join('')}<a class="btn btn-ghost btn-small" href="#/settings">Gérer les connexions</a>` : '' });
}

/** Alerte compacte unique + pied de page minimal. Le détail (statuts, jetons, actions) vit dans Paramètres : aucune répétition. */
export async function refreshShell({ isSocial }) {
  const foot = document.getElementById('sidebar-foot'), notices = document.getElementById('notices');
  let st;
  try { st = await Api.getStatus(); } catch (e) { foot.innerHTML = '<span>Connexion au serveur indisponible</span> <a class="text-link" href="#/settings">Paramètres</a>'; return; }
  const isApi = st.mode === 'api';
  if (isApi) {
    const live = PLATFORMS.filter((p) => st.platforms[p] && st.platforms[p].status === 'connected' && !(st.platforms[p].token && st.platforms[p].token.health === 'reconnect_required')).length;
    foot.innerHTML = `<span>Serveur à jour le ${esc(fmtDateTime(st.serverTime))}</span><a class="text-link" href="#/settings">Connexions : ${live} sur ${PLATFORMS.length} actives</a>`;
  }
  const items = flash.splice(0).map((n) => `<div class="notice notice--${n.kind}" role="${n.kind === 'err' ? 'alert' : 'status'}">${n.html}</div>`);
  const alerts = isApi && isSocial && state.route !== 'settings' ? actionableAlerts(connectionAlerts(st.platforms)) : [];
  if (alerts.length) items.push(alertOf(alerts, { withActions: true }));
  const html = items.join('');
  if (notices._h !== html) { notices._h = html; notices.innerHTML = html; } // inchangé : on ne réécrit pas (une alerte ne doit pas être ré-annoncée à chaque mise à jour silencieuse)
  notices.hidden = !items.length;
}

// ---------------------------------------------------------------- Actions de la page Paramètres
let hooks = { announce: () => {}, rerender: async () => false, rerenderFull: async () => {} };
/** Le routeur fournit : announce (zone role=status), rerender (re-lecture SILENCIEUSE de la page : focus, défilement conservés), rerenderFull (rendu complet). */
export function bindConnections(h) { hooks = { ...hooks, ...h }; }

// État d'interface par réseau : { busy:'renew'|'refresh'|null, lock:{renew, refresh}, msg:{kind, text, lead, tail, lockKey}|null, highlight:boolean }
const ui = new Map();
const uiOf = (p) => { if (!ui.has(p)) ui.set(p, { busy: null, lock: {}, msg: null, highlight: false }); return ui.get(p); };
const lockedUntil = (p, k) => { const t = uiOf(p).lock[k]; return t && t > Date.now() ? t : 0; };

let tickTimer = null;
function ensureTick() { if (!tickTimer) tickTimer = setInterval(tick, 1000); }
function tick() {
  const now = Date.now();
  let pending = false, expired = false;
  for (const s of ui.values()) for (const k of Object.keys(s.lock)) { if (s.lock[k] <= now) { delete s.lock[k]; if (s.msg && s.msg.lockKey === k) s.msg = null; expired = true; } else pending = true; }
  document.querySelectorAll('[data-countdown]').forEach((el) => { el.textContent = countdownText(Number(el.dataset.countdown), now); });
  if (!pending) { clearInterval(tickTimer); tickTimer = null; }
  if (expired) hooks.rerender();
}

const MSG_ICON = { ok: STATUS_ICONS.ok, info: STATUS_ICONS.info, warn: STATUS_ICONS.warn, error: STATUS_ICONS.error };
function messageHtml(p) {
  const m = uiOf(p).msg; if (!m) return '';
  if (!m.lockKey && Date.now() - m.at > 90_000) return ''; // un résultat ancien n'est plus affiché
  const body = m.lead && m.lockUntil > Date.now() ? `${esc(m.lead)}<span data-countdown="${m.lockUntil}">${esc(countdownText(m.lockUntil))}</span>${esc(m.tail || '')}` : esc(m.text);
  return `<p class="conn-msg conn-msg--${esc(m.kind)}" data-conn-msg="${esc(p)}"><span aria-hidden="true">${MSG_ICON[m.kind] || ''}</span><span>${body}</span></p>`;
}

const VARIANT = { primary: 'btn btn-accent btn-small', secondary: 'btn btn-ghost btn-small', danger: 'btn btn-danger btn-small' };
function actionButton(a, p) {
  const s = uiOf(p), cls = VARIANT[a.variant] || VARIANT.secondary, name = LABELS[p];
  if (a.link) return `<a class="${cls}" href="${esc(a.href)}" aria-label="${esc(a.aria)}">${esc(a.label)}</a>`;
  const own = a.id === 'renew' || a.id === 'refresh';
  const busy = own && s.busy === a.id, lock = own ? lockedUntil(p, a.id) : 0;
  const disabled = a.disabled || busy || lock || (own && s.busy);
  const title = busy ? '' : lock ? `Disponible dans ${countdownText(lock)}` : a.reason || a.title || '';
  const icon = a.id === 'refresh' ? ICON.refresh : '';
  return `<button type="button" class="${cls}" data-conn-act="${a.id}:${esc(p)}" aria-label="${esc(busy ? `${a.aria} : en cours` : a.aria)}"${disabled ? ' aria-disabled="true"' : ''}${busy ? ' aria-busy="true"' : ''}${title ? ` title="${esc(title)}"` : ''}>${icon}${esc(busy ? TOKEN_TEXT.busy : a.label)}</button>`;
}

function actionsCell(p, x) {
  const v = tokenView(p, x, Date.now(), { apiBase: Api.connectUrl(p).replace(/\/auth\/.*$/, '') }), name = LABELS[p], s = uiOf(p);
  if (!v.actions.length) return v.hint ? `<span class="muted">${esc(v.hint)}</span>` : '<span class="muted">—</span>';
  // Une demande de reconnexion (409 reconnect_required / not_refreshable) met « Reconnecter » en avant.
  const actions = v.actions.map((a) => (a.id === 'reconnect' && s.highlight ? { ...a, variant: 'primary' } : a));
  return `<div class="cell cell--actions">${ButtonGroup(actions.map((a) => actionButton(a, p)).join(''), `Actions ${name}`).replace('class="btn-group"', 'class="btn-group conn-actions"')}${messageHtml(p)}</div>`;
}

function tokenCell(p, x) {
  const v = tokenView(p, x, Date.now());
  if (!v.badge) return x.connected ? '<span class="muted">Indisponible</span>' : '<span aria-hidden="true">—</span><span class="sr-only">non disponible</span>';
  const line = (l) => `<span class="cell-sub">${esc(l.label)} : <time datetime="${esc(l.iso)}">${esc(fmtDateTime(l.iso))}</time></span>`;
  return `<div class="cell">${StatusBadge(v.badge)}${v.note ? `<span class="cell-note">${esc(v.note)}</span>` : ''}${v.accessLine ? line(v.accessLine) : ''}${v.refreshLine ? line(v.refreshLine) : ''}${v.renewedLine ? `<span class="cell-sub">${esc(v.renewedLine)}</span>` : ''}${v.error ? `<span class="cell-err">${esc(v.error)}</span>` : ''}</div>`;
}

async function afterAction(p, outcome, { announceIt = true } = {}) {
  const s = uiOf(p);
  s.busy = null;
  s.msg = { at: Date.now(), kind: outcome.kind, text: outcome.text, lead: outcome.lead, tail: outcome.tail, lockUntil: outcome.lockUntil, lockKey: outcome.lockUntil ? outcome.lockKey : null };
  if (outcome.lockUntil) { s.lock[outcome.lockKey] = outcome.lockUntil; ensureTick(); }
  if (!(await hooks.rerender())) { await new Promise((r) => setTimeout(r, 600)); await hooks.rerender(); }
  if (announceIt) hooks.announce(outcome.text);
}

async function runAction(kind, p, btn) {
  const s = uiOf(p);
  if (s.busy || lockedUntil(p, kind)) return;
  s.busy = kind; s.msg = null; s.highlight = false;
  btn.setAttribute('aria-disabled', 'true'); btn.setAttribute('aria-busy', 'true'); btn.textContent = TOKEN_TEXT.busy; // retour immédiat, sans re-rendu
  try {
    if (kind === 'renew') {
      const r = await Api.renewToken(p);
      await afterAction(p, { ...renewOutcome(p, r), lockKey: 'renew' });
    } else {
      const r = await Api.refreshPlatform(p);
      await afterAction(p, { ...refreshOutcome(p, r), lockKey: 'refresh' });
    }
  } catch (err) {
    if (err && err.code === 'unauthenticated') { s.busy = null; return; }
    const o = kind === 'renew' ? renewOutcome(p, err) : refreshOutcome(p, err);
    if (kind === 'renew' && o.highlightReconnect) s.highlight = true;
    await afterAction(p, { ...o, lockKey: kind });
  }
}

async function runDisconnect(p, btn) {
  const name = LABELS[p];
  const ok = await confirmDialog({ title: `Déconnecter ${name} ?`, confirm: `Déconnecter ${name}`, danger: true,
    text: `<p>Le jeton ${esc(name)} sera supprimé du serveur et les statistiques ${esc(name)} ne seront plus actualisées.</p><p class="muted">Vous pourrez reconnecter le compte à tout moment avec « Connecter ».</p>` });
  if (!ok) return false;
  try { await Api.disconnect(p); ui.delete(p); flash.push({ kind: 'ok', html: `${platformBadge(p)} ${esc(name)} déconnecté.` }); } catch (err) { if (err && err.code === 'unauthenticated') return false; flash.push({ kind: 'err', html: esc((err && err.message) || `Déconnexion de ${name} impossible.`) }); }
  await hooks.rerenderFull();
  return true;
}

/** Clic sur un bouton `data-conn-act="<action>:<réseau>"` (délégation du routeur). */
export function handleConnAction(el) {
  const [act, p] = String(el.dataset.connAct || '').split(':');
  if (!PLATFORMS.includes(p) || el.getAttribute('aria-disabled') === 'true') return;
  if (act === 'renew' || act === 'refresh') return runAction(act, p, el);
  if (act === 'disconnect') return runDisconnect(p, el);
}

// ---- Section « Connexions sociales » (Paramètres) ----
const dash = '<span aria-hidden="true">—</span><span class="sr-only">non disponible</span>';
const ttl = (iso) => (iso && !Number.isNaN(Date.parse(iso)) ? iso : null);

/** Section « Connexions sociales » à partir de /api/status (ou erreur). `extra` : HTML de confiance ajouté dans la section (procédure LinkedIn). */
export function connectionsCard(statusResult, extra = '') {
  let body;
  if (statusResult.status === 'fulfilled') {
    const platforms = statusResult.value.platforms;
    const rows = PLATFORMS.map((p) => ({ p, x: platforms[p] || {} }));
    const all = connectionAlerts(platforms);
    const info = all.filter((a) => a.level === 'info').map((a) => `<p class="muted conn-info">${esc(a.text)}.</p>`).join('');
    body = `${alertOf(actionableAlerts(all))}${DataTable({
      id: 'conn-table', rows, pageSize: 10, caption: 'Connexions aux réseaux sociaux : compte, statut, jeton, dernière synchronisation et actions',
      columns: [
        { key: 'network', label: 'Réseau', sortable: false, render: ({ p }) => `<span class="network-title">${PLATFORM_ICONS[p]}${esc(LABELS[p])}</span>` },
        { key: 'account', label: 'Compte', sortable: false, render: ({ p, x }) => (x.account && (x.account.name || x.account.handle) ? `<div class="cell"><strong>${esc(x.account.name || x.account.handle)}</strong>${x.account.name && x.account.handle ? `<span class="cell-sub">${esc(x.account.handle)}</span>` : ''}</div>` : x.connected ? '<span class="muted">Compte non communiqué</span>' : '<span class="muted">Non relié</span>') },
        { key: 'status', label: 'Statut', sortable: false, render: ({ x }) => `<div class="cell">${StatusBadge({ kind: statusKind(x.status), label: statusLabel(x.status) })}${x.message && x.status !== 'connected' && x.status !== 'pending_approval' ? `<span class="cell-sub">${esc(x.message)}</span>` : ''}</div>` },
        { key: 'token', label: 'Jeton', sortable: false, render: ({ p, x }) => tokenCell(p, x) },
        { key: 'sync', label: 'Dernière synchro', sortable: false, render: ({ x }) => {
          const b = x.budget && Number.isFinite(x.budget.used) && Number.isFinite(x.budget.limit) ? `<span class="cell-sub">Budget d’appels : ${esc(x.budget.used)} / ${esc(x.budget.limit)} aujourd’hui</span>` : '';
          if (!ttl(x.lastFetchAt)) return `<div class="cell">${x.connected ? '<span class="muted">Aucune synchro enregistrée</span>' : dash}${b}</div>`;
          return `<div class="cell"><time datetime="${esc(x.lastFetchAt)}" title="${esc(fmtDateTime(x.lastFetchAt))}">${esc(relTime(x.lastFetchAt))}</time><span class="cell-sub">${esc(fmtDateTime(x.lastFetchAt))}</span>${b}</div>`;
        } },
        { key: 'actions', label: 'Actions', sortable: false, render: ({ p, x }) => actionsCell(p, x) }
      ]
    })}${info}`;
  } else body = errorCard(statusResult.reason);
  return `<section class="card" aria-labelledby="set-conn">${SectionHeader({ title: 'Connexions sociales', sub: 'Comptes reliés, état des jetons et dernière synchronisation', id: 'set-conn' })}${body}${extra}</section>`;
}

export async function render() {
  const status = await Promise.allSettled([Api.getStatus()]);
  return { markup: connectionsCard(status[0]) };
}
