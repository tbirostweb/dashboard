// Santé des jetons (sans appel réseau, sans secret) : ce que l'utilisateur doit réellement faire, et quand.
// TikTok : le jeton d'ACCÈS (24 h) est renouvelé automatiquement ; seule l'échéance du refresh token (365 j) compte.
// Instagram : jeton long (60 j) renouvelé automatiquement dès < 7 j et >= 24 h d'âge.
// LinkedIn : jeton 60 j, sans renouvellement programmatique pour la plupart des apps (reconnexion manuelle).
const DAY = 86_400_000;
export const TIKTOK_SOON_MS = 30 * DAY;
export const INSTAGRAM_RENEW_WINDOW_MS = 7 * DAY;
export const LINKEDIN_SOON_MS = 14 * DAY;
export const RENEW_MIN_RETRY_MS = 15 * 60_000;       // plancher entre deux tentatives automatiques
export const RENEW_MAX_RETRY_MS = 6 * 3_600_000;     // plafond du backoff transitoire
export const RENEW_PERMANENT_RETRY_MS = 6 * 3_600_000;

export const RENEW_ERROR_MESSAGES = {
  transient: 'Le dernier renouvellement automatique a échoué (réseau ou service indisponible) ; nouvelle tentative prévue.',
  permanent: 'Le fournisseur a refusé le renouvellement du jeton : reconnectez le compte.'
};

const MONTHS = ['janv.', 'févr.', 'mars', 'avr.', 'mai', 'juin', 'juil.', 'août', 'sept.', 'oct.', 'nov.', 'déc.'];
/** « 1 oct. 2027 » (UTC, sans dépendance à ICU). */
export function frDate(ms) {
  const d = new Date(ms);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

export const reconnectPathOf = (platform) => `/api/auth/${platform}/login`;
const iso = (ms) => (Number.isFinite(ms) ? new Date(ms).toISOString() : null);

/** Délai avant la prochaine tentative automatique après `failures` échecs consécutifs. */
export function retryDelayMs(failures, permanent) {
  if (permanent) return RENEW_PERMANENT_RETRY_MS;
  return Math.min(RENEW_MIN_RETRY_MS * 2 ** Math.max(0, failures - 1), RENEW_MAX_RETRY_MS);
}

/**
 * @param {object} p { platform, token, meta, now, pending }
 *   meta : { lastRenewedAt, lastRenewError: { message, at, permanent } | null } (métadonnées non sensibles)
 */
export function tokenStatus({ platform, token, meta, now, pending = false }) {
  const err = meta && meta.lastRenewError ? meta.lastRenewError : null;
  const out = {
    kind: platform === 'linkedin' && !(token && token.refreshToken) ? 'manual' : 'auto',
    autoRenew: false,
    accessExpiresAt: token ? iso(token.expiresAt) : null,
    refreshExpiresAt: token && token.refreshExpiresAt ? iso(token.refreshExpiresAt) : null,
    lastRenewedAt: (meta && meta.lastRenewedAt) || null,
    lastRenewError: err ? err.message : null,
    health: 'not_connected',
    reconnectBy: null,
    reconnectPath: null,
    note: 'Compte non connecté.'
  };
  if (pending) return { ...out, kind: 'manual', health: 'pending', note: "En attente d'approbation LinkedIn : aucun jeton à surveiller." };
  if (!token) return out;

  const path = reconnectPathOf(platform);
  const soon = (by, note) => ({ ...out, health: 'reconnect_soon', reconnectBy: iso(by), reconnectPath: path, note });
  const required = (by, note) => ({ ...out, health: 'reconnect_required', reconnectBy: iso(by), reconnectPath: path, note });
  const permanent = Boolean(err && err.permanent);
  const refreshAt = token.refreshExpiresAt || null;

  if (platform === 'instagram') {
    out.autoRenew = true;
    const left = token.expiresAt - now;
    if (left <= 0) return required(token.expiresAt, 'Le jeton Instagram a expiré : reconnectez le compte.');
    if (permanent) return required(token.expiresAt, RENEW_ERROR_MESSAGES.permanent);
    if (left >= INSTAGRAM_RENEW_WINDOW_MS) return { ...out, health: 'ok', note: `Jeton long renouvelé automatiquement (valable jusqu'au ${frDate(token.expiresAt)}).` };
    if (err) return soon(token.expiresAt, `Le renouvellement automatique échoue : reconnectez le compte avant le ${frDate(token.expiresAt)}.`);
    return { ...out, health: 'renewing', note: `Renouvellement automatique en cours ou imminent (jeton valable jusqu'au ${frDate(token.expiresAt)}).` };
  }

  const refreshable = Boolean(token.refreshToken);
  if (!refreshable) { // LinkedIn habituel (et TikTok sans refresh token : cas anormal) : reconnexion manuelle
    out.kind = 'manual';
    const left = token.expiresAt - now;
    if (left <= 0) return required(token.expiresAt, 'Le jeton a expiré : reconnectez le compte.');
    const horizon = platform === 'linkedin' ? LINKEDIN_SOON_MS : DAY;
    if (left < horizon) return soon(token.expiresAt, `Pas de renouvellement automatique : reconnectez le compte avant le ${frDate(token.expiresAt)}.`);
    return { ...out, health: 'ok', reconnectBy: iso(token.expiresAt), note: `Pas de renouvellement automatique ; reconnexion nécessaire avant le ${frDate(token.expiresAt)}.` };
  }

  // TikTok (et LinkedIn avec refresh token) : échéance utilisateur = refresh token
  out.autoRenew = true;
  if (refreshAt && refreshAt <= now) return required(refreshAt, 'Le jeton de renouvellement a expiré : reconnectez le compte.');
  if (permanent) return required(refreshAt, RENEW_ERROR_MESSAGES.permanent);
  if (refreshAt && refreshAt - now < TIKTOK_SOON_MS) return soon(refreshAt, `Le jeton de renouvellement arrive à échéance : reconnectez le compte avant le ${frDate(refreshAt)}.`);
  if (err && token.expiresAt <= now) return { ...out, health: 'renewing', reconnectBy: iso(refreshAt), note: 'Le renouvellement automatique a échoué ; nouvelle tentative prévue.' };
  return { ...out, health: 'ok', reconnectBy: iso(refreshAt), note: refreshAt ? `Renouvelé automatiquement ; reconnexion nécessaire avant le ${frDate(refreshAt)}` : 'Renouvelé automatiquement.' };
}
