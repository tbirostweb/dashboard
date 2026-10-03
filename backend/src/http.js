// Client HTTP minimal pour les API des plateformes.
// Règle : les messages d'erreur ne contiennent JAMAIS l'URL (qui peut porter un access_token) ni les en-têtes.

export class ProviderError extends Error {
  /**
   * @param {string} platform
   * @param {string} code  'auth' (token invalide/expiré), 'rate_limit', 'permission', 'upstream', 'network', 'config'
   * @param {string} message message lisible, sans secret
   * @param {number} [status] statut HTTP de la plateforme
   */
  constructor(platform, code, message, status) {
    super(message);
    this.name = 'ProviderError';
    this.platform = platform;
    this.code = code;
    this.status = status;
  }
}

const SECRETISH = /([A-Za-z0-9_\-.]{40,})/g; // longues chaînes opaques (tokens) éventuellement renvoyées dans les erreurs
export const scrub = (s) => String(s ?? '').replace(SECRETISH, '[masqué]').slice(0, 300);

function classify(status) {
  if (status === 401) return 'auth';
  if (status === 403) return 'permission';
  if (status === 429) return 'rate_limit';
  return 'upstream';
}

/**
 * fetch JSON avec timeout. `fetchImpl` est injectable (tests).
 * Renvoie le JSON ; lève ProviderError sinon.
 */
export async function fetchJson(fetchImpl, platform, url, { method = 'GET', headers = {}, body, form, json, timeoutMs = 15_000 } = {}) {
  const init = { method, headers: { Accept: 'application/json', ...headers }, signal: AbortSignal.timeout(timeoutMs) };
  if (form) {
    init.body = new URLSearchParams(form).toString();
    init.headers['Content-Type'] = 'application/x-www-form-urlencoded';
  } else if (json !== undefined) {
    init.body = JSON.stringify(json);
    init.headers['Content-Type'] = 'application/json';
  } else if (body !== undefined) {
    init.body = body;
  }

  let res;
  try {
    res = await fetchImpl(url, init);
  } catch (err) {
    throw new ProviderError(platform, 'network', `Plateforme injoignable (${err.name === 'TimeoutError' ? 'délai dépassé' : 'erreur réseau'}).`);
  }

  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : {}; } catch { data = null; }

  if (!res.ok) {
    const apiMsg = data && (data.error_description || data.message || (data.error && (data.error.message || data.error)) || data.serviceErrorCode);
    // Graph API : code 190 = token invalide/expiré
    const graphCode = data && data.error && data.error.code;
    const code = graphCode === 190 ? 'auth' : classify(res.status);
    throw new ProviderError(platform, code, `Erreur API ${res.status}${apiMsg ? ` : ${scrub(typeof apiMsg === 'string' ? apiMsg : JSON.stringify(apiMsg))}` : ''}`, res.status);
  }
  if (data === null) throw new ProviderError(platform, 'upstream', 'Réponse non JSON de la plateforme.', res.status);
  return data;
}
