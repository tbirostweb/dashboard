/* Jetons des réseaux : logique PURE (aucun DOM, aucun réseau, horloge passée en paramètre) — testée par backend/test/frontend-tokens.test.js.
   Source unique des libellés de jeton (réexportés par labels.js). Entrée : `platforms.<réseau>.token` de GET /api/status
   { kind:'auto'|'manual', autoRenew, accessExpiresAt, refreshExpiresAt, lastRenewedAt, lastRenewError, health, reconnectBy, reconnectPath, note }.
   Règle d'or : l'échéance du jeton d'ACCÈS (24 h pour TikTok) n'est JAMAIS une échéance utilisateur quand `autoRenew` est vrai. */
import { fmtDate, fmtDateTime } from './format.js?v=16';
import { parseRetryAfter } from './live-logic.js?v=16';

export const NAMES = { tiktok: 'TikTok', instagram: 'Instagram', linkedin: 'LinkedIn' };
export const nameOf = (p) => NAMES[p] || String(p || 'Réseau');

export const TOKEN_TEXT = {
  ok: 'Renouvelé automatiquement', okManual: 'Jeton valide', renewing: 'Renouvellement en cours', soon: 'Reconnexion à prévoir', required: 'Reconnexion nécessaire',
  pending: 'En attente d’approbation', notConnected: 'Non relié',
  accessAuto: 'Jeton d’accès (renouvelé automatiquement)', accessManual: 'Jeton d’accès', refreshUntil: 'Renouvellement possible jusqu’au',
  neverRenewed: 'jamais depuis la connexion',
  open: 'Ouvrir la page', refresh: 'Actualiser les données', renew: 'Renouveler le jeton', reconnect: 'Reconnecter', disconnect: 'Déconnecter', connect: 'Connecter', busy: 'En cours…',
  refreshTip: 'Relit les statistiques du réseau ; ne renouvelle pas le jeton.',
  renewTip: (n) => `Demande un nouveau jeton à ${n} maintenant ; en temps normal c’est automatique.`,
  notRenewable: 'Ce jeton ne se renouvelle pas automatiquement : utilisez « Reconnecter ».',
  needsReconnect: 'Le renouvellement n’est plus possible : reconnectez le compte.'
};

const HEALTHS = ['ok', 'renewing', 'reconnect_soon', 'reconnect_required', 'not_connected', 'pending'];
export const healthOf = (token) => (token && HEALTHS.includes(token.health) ? token.health : null);
const validIso = (s) => (typeof s === 'string' && s && !Number.isNaN(Date.parse(s)) ? s : null);

// ---------------------------------------------------------------- Badge
/** Santé du jeton → { health, kind, label } pour StatusBadge ; null si l'API ne fournit pas de `token`. Le vert n'est jamais un statut. */
export function tokenBadge(token) {
  const h = healthOf(token); if (!h) return null;
  if (h === 'ok') return { health: h, kind: 'ok', label: token.kind === 'manual' || token.autoRenew === false ? TOKEN_TEXT.okManual : TOKEN_TEXT.ok };
  if (h === 'renewing') return { health: h, kind: 'info', label: TOKEN_TEXT.renewing };
  if (h === 'reconnect_soon') { const d = validIso(token.reconnectBy); return { health: h, kind: 'warn', label: d ? `Reconnexion à prévoir avant le ${fmtDate(d)}` : TOKEN_TEXT.soon }; }
  if (h === 'reconnect_required') return { health: h, kind: 'error', label: TOKEN_TEXT.required };
  if (h === 'pending') return { health: h, kind: 'pending', label: TOKEN_TEXT.pending };
  return { health: h, kind: 'neutral', label: TOKEN_TEXT.notConnected };
}
/** Badge pour les pages plateforme / la synthèse : seulement quand quelque chose mérite l'attention (santé ≠ ok, ni « non relié » ni « en attente » déjà traités ailleurs). */
export function attentionBadge(token) {
  const b = tokenBadge(token);
  return b && ['renewing', 'reconnect_soon', 'reconnect_required'].includes(b.health) ? b : null;
}

// ---------------------------------------------------------------- Libellés de durée
/** « à l’instant » / « il y a 5 min » / « il y a 3 h » / « il y a 2 j » ; au-delà de 30 jours : la date. Date illisible → null. */
export function agoLabel(iso, now = Date.now()) {
  const t = Date.parse(iso); if (!Number.isFinite(t)) return null;
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 60) return 'à l’instant';
  if (s < 3600) return `il y a ${Math.round(s / 60)} min`;
  if (s < 86400) return `il y a ${Math.round(s / 3600)} h`;
  if (s < 30 * 86400) return `il y a ${Math.round(s / 86400)} j`;
  return `le ${fmtDate(t)}`;
}
/** « Dernier renouvellement : il y a 5 min » / « … : jamais depuis la connexion ». */
export const renewedLabel = (iso, now = Date.now()) => `Dernier renouvellement : ${agoLabel(iso, now) || TOKEN_TEXT.neverRenewed}`;
/** Compte à rebours discret : « 25 s », « 1 min 05 s », au-delà de 10 min « 12 min ». Échu → « 0 s ». */
export function countdownText(untilMs, now = Date.now()) {
  const s = Math.max(0, Math.ceil((untilMs - now) / 1000));
  if (s < 60) return `${s} s`;
  if (s < 600) return `${Math.floor(s / 60)} min ${String(s % 60).padStart(2, '0')} s`;
  if (s < 3600) return `${Math.ceil(s / 60)} min`;
  return `${Math.ceil(s / 3600)} h`;
}

// ---------------------------------------------------------------- Liens OAuth
/** Chemin de reconnexion fourni par le backend, accepté seulement s'il a la forme /api/auth/<réseau>/login (navigation, jamais un fetch). */
export function reconnectHref(platform, path, apiBase = '/api') {
  if (typeof path === 'string' && /^\/api\/auth\/(tiktok|instagram|linkedin)\/login$/.test(path) && path.split('/')[3] === platform) return path;
  return `${apiBase}/auth/${platform}/login`;
}

// ---------------------------------------------------------------- Vue d'une ligne (Paramètres)
/**
 * tokenView(platform, x, now) : tout ce qu'une ligne « Connexions sociales » affiche pour le jeton.
 * x = platforms.<réseau> de /api/status. Retourne
 *   { connected, badge, note, accessLine:{label, iso}|null, refreshLine:{label, iso}|null, renewedLine, error, actions:[{id, label, aria, variant, link?, href?, disabled?, reason?, title?}], hint }
 * Ordre des actions : open, refresh, renew, reconnect, disconnect (non relié : connect seul).
 */
export function tokenView(platform, x = {}, now = Date.now(), { apiBase = '/api' } = {}) {
  const n = nameOf(platform), t = x.token || null, h = healthOf(t) || (x.status === 'pending_approval' ? 'pending' : x.connected ? null : 'not_connected');
  const connected = Boolean(x.connected) && h !== 'not_connected' && h !== 'pending';
  const view = { platform, connected, health: h, badge: t ? tokenBadge(t) : null, note: (t && typeof t.note === 'string' && t.note) || null, accessLine: null, refreshLine: null, renewedLine: null, error: null, actions: [], hint: null };
  const login = reconnectHref(platform, t && t.reconnectPath, apiBase);
  if (!connected) {
    if (h === 'pending') { view.hint = 'Accès LinkedIn en cours de validation'; return view; }
    if (x.configured === false) { view.hint = 'Identifiants de l’application absents sur le serveur'; return view; }
    view.actions.push({ id: 'connect', label: TOKEN_TEXT.connect, aria: `Connecter ${n}`, variant: 'primary', link: true, href: reconnectHref(platform, null, apiBase) });
    return view;
  }
  const auto = Boolean(t) && t.kind === 'auto' && t.autoRenew !== false;
  const acc = t && validIso(t.accessExpiresAt);
  if (acc) view.accessLine = { label: auto ? TOKEN_TEXT.accessAuto : TOKEN_TEXT.accessManual, iso: acc, auto };
  const ref = t && validIso(t.refreshExpiresAt);
  if (ref && auto) view.refreshLine = { label: TOKEN_TEXT.refreshUntil, iso: ref };
  if (auto) view.renewedLine = renewedLabel(t.lastRenewedAt, now);
  if (t && typeof t.lastRenewError === 'string' && t.lastRenewError) view.error = t.lastRenewError;
  const urgent = h === 'reconnect_required' || h === 'reconnect_soon';
  view.actions.push({ id: 'open', label: TOKEN_TEXT.open, aria: `Ouvrir la page ${n}`, variant: 'secondary', link: true, href: `#/social/${platform}` });
  view.actions.push({ id: 'refresh', label: TOKEN_TEXT.refresh, aria: `Actualiser les données ${n}`, variant: 'secondary', title: TOKEN_TEXT.refreshTip });
  if (auto) {
    const blocked = h === 'reconnect_required';
    view.actions.push({ id: 'renew', label: TOKEN_TEXT.renew, aria: `Renouveler le jeton ${n}`, variant: 'secondary', title: blocked ? TOKEN_TEXT.needsReconnect : TOKEN_TEXT.renewTip(n), ...(blocked ? { disabled: true, reason: TOKEN_TEXT.needsReconnect } : {}) });
  }
  view.actions.push({ id: 'reconnect', label: TOKEN_TEXT.reconnect, aria: `Reconnecter ${n}`, variant: urgent ? 'primary' : 'secondary', link: true, href: login });
  view.actions.push({ id: 'disconnect', label: TOKEN_TEXT.disconnect, aria: `Déconnecter ${n}`, variant: 'danger' });
  return view;
}

// ---------------------------------------------------------------- Alertes globales
/**
 * connectionAlerts(platforms) : [{platform, level:'alert'|'info', kind:'warn'|'error'|'info', text, reconnectPath}].
 * N'alerte QUE pour reconnect_soon / reconnect_required ; LinkedIn en attente = information discrète. JAMAIS à cause de `accessExpiresAt`.
 * Sans objet `token` (ancien serveur) : seul le statut « expired » compte.
 */
export function connectionAlerts(platforms = {}) {
  const out = [];
  for (const p of Object.keys(NAMES)) {
    const x = platforms[p]; if (!x) continue;
    const n = nameOf(p), t = x.token || null, h = healthOf(t);
    if (h === 'reconnect_required' || (!t && x.status === 'expired')) out.push({ platform: p, level: 'alert', kind: 'error', text: `${n} : reconnexion nécessaire maintenant`, reconnectPath: reconnectHref(p, t && t.reconnectPath) });
    else if (h === 'reconnect_soon') { const d = validIso(t.reconnectBy); out.push({ platform: p, level: 'alert', kind: 'warn', text: d ? `${n} : reconnexion nécessaire avant le ${fmtDate(d)}` : `${n} : reconnexion à prévoir prochainement`, reconnectPath: reconnectHref(p, t.reconnectPath) }); }
    else if (h === 'pending' || x.status === 'pending_approval') out.push({ platform: p, level: 'info', kind: 'info', text: `${n} : en attente d’approbation`, reconnectPath: null });
  }
  return out;
}
/** Les alertes qui méritent un bandeau (sans les informations discrètes). */
export const actionableAlerts = (list) => list.filter((a) => a.level === 'alert');

// ---------------------------------------------------------------- Résultat d'une action
const codeOf = (err) => (err && (err.code || (err.data && err.data.error))) || '';
const statusOf = (err) => (err && Number(err.status)) || 0;
const retryOf = (err, fallbackMs, now) => { const ra = err && (err.retryAfter ?? (err.data && err.data.retryAfter)); return now + (parseRetryAfter(ra, now) ?? fallbackMs); };

/**
 * renewOutcome(platform, result, now) : result = réponse JSON 200 ({ok:true, …}) OU erreur typée de Api.renewToken ({status, code, message, retryAfter, eligibleAt, reconnectPath, data}).
 * → { kind:'ok'|'info'|'warn'|'error', text, lockUntil:number|null, highlightReconnect:boolean, reconnectPath, ok }
 * Jamais de détail technique ni de secret : les textes sont ceux de ce module (le message du backend n'est repris que pour un « déjà à jour »).
 */
export function renewOutcome(platform, result, now = Date.now()) {
  const n = nameOf(platform), base = { lockUntil: null, highlightReconnect: false, reconnectPath: null, ok: false };
  if (result && result.ok === true && !(result instanceof Error)) {
    if (result.renewed === false) return { ...base, ok: true, kind: 'info', text: (typeof result.message === 'string' && result.message) || `Le jeton ${n} est déjà à jour.` };
    const until = validIso(result.expiresAt), ref = validIso(result.refreshExpiresAt);
    const text = `Jeton ${n} renouvelé${until ? ` — valable jusqu’au ${fmtDateTime(until)}` : ''}${ref ? `, renouvelable jusqu’au ${fmtDate(ref)}` : ''}.`;
    return { ...base, ok: true, kind: 'ok', text };
  }
  const code = codeOf(result), status = statusOf(result), path = (result && (result.reconnectPath || (result.data && result.data.reconnectPath))) || null;
  if (status === 409 || ['reconnect_required', 'not_refreshable', 'not_connected', 'pending_approval', 'too_soon'].includes(code)) {
    if (code === 'reconnect_required') return { ...base, kind: 'error', text: `La connexion à ${n} a expiré ou a été refusée : reconnectez le compte.`, highlightReconnect: true, reconnectPath: path };
    if (code === 'not_refreshable') return { ...base, kind: 'warn', text: `Le jeton ${n} ne peut pas être renouvelé automatiquement : reconnectez le compte.`, highlightReconnect: true, reconnectPath: path };
    if (code === 'not_connected') return { ...base, kind: 'warn', text: `${n} n’est pas relié.` };
    if (code === 'pending_approval') return { ...base, kind: 'info', text: `L’accès ${n} est en attente d’approbation.` };
    if (code === 'too_soon') {
      const el = result.eligibleAt || (result.data && result.data.eligibleAt), t = Date.parse(el);
      const lockUntil = Number.isFinite(t) ? t : retryOf(result, 24 * 3600_000, now);
      return { ...base, kind: 'info', lockUntil, text: Number.isFinite(t) ? `${n} permet le renouvellement à partir du ${fmtDateTime(t)}.` : `${n} ne permet pas encore le renouvellement : réessayez plus tard.` };
    }
  }
  if (status === 429 || code === 'refresh_too_soon' || code === 'too_many_requests') {
    const lockUntil = retryOf(result, 30_000, now);
    return { ...base, kind: 'warn', lockUntil, text: `Trop de demandes pour ${n} : réessayez dans ${countdownText(lockUntil, now)}.`, lead: `Trop de demandes pour ${n} : réessayez dans `, tail: '.' };
  }
  if (status === 502 || code === 'upstream') return { ...base, kind: 'error', text: 'Le réseau ne répond pas, réessayez.' };
  return { ...base, kind: 'error', text: `Le jeton ${n} n’a pas pu être renouvelé pour le moment. Réessayez plus tard.` };
}

/** refreshOutcome(platform, result, now) : « Actualiser les données » (POST /api/platforms/:p/refresh) — 200 / 409 / 429 / autre. */
export function refreshOutcome(platform, result, now = Date.now()) {
  const n = nameOf(platform), base = { lockUntil: null, ok: false };
  if (result && result.ok === true && !(result instanceof Error)) {
    if (result.status === 'budget_exhausted') return { ...base, ok: true, kind: 'info', text: (typeof result.message === 'string' && result.message) || `${n} : budget d’appels atteint, données précédentes conservées.` };
    return { ...base, ok: true, kind: 'ok', text: `Données ${n} actualisées.` };
  }
  const code = codeOf(result), status = statusOf(result);
  if (status === 429 || code === 'refresh_too_soon') { const lockUntil = retryOf(result, 60_000, now); return { ...base, kind: 'warn', lockUntil, text: `Actualisation de ${n} possible dans ${countdownText(lockUntil, now)}.`, lead: `Actualisation de ${n} possible dans `, tail: '.' }; }
  if (status === 409 || ['not_connected', 'pending_approval', 'token_expired'].includes(code)) {
    return { ...base, kind: 'warn', text: code === 'pending_approval' ? `L’accès ${n} est en attente d’approbation.` : code === 'token_expired' ? `La connexion à ${n} a expiré : reconnectez le compte.` : `${n} n’est pas relié.` };
  }
  if (status === 502 || code === 'upstream' || code === 'provider_error') return { ...base, kind: 'error', text: 'Le réseau ne répond pas, réessayez.' };
  return { ...base, kind: 'error', text: `Actualisation de ${n} impossible pour le moment.` };
}
