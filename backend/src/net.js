// Transport HTTP sortant : connexions persistantes (keep-alive) réutilisées par tous les appels fournisseurs et Dokploy.
// Évite un handshake TCP + TLS par appel (le premier chargement Instagram/TikTok enchaîne des dizaines de requêtes).
import { Agent, fetch as undiciFetch } from 'undici';

/**
 * Renvoie { fetch, close }. `pipelining: 1` = une requête à la fois par connexion (pipelining HTTP désactivé,
 * source de blocages en tête de file) ; le parallélisme vient du nombre de connexions par origine.
 */
export function createKeepAliveFetch({ connections = 16, keepAliveTimeoutMs = 30_000 } = {}) {
  const dispatcher = new Agent({
    connections,
    pipelining: 1,
    keepAliveTimeout: keepAliveTimeoutMs,
    keepAliveMaxTimeout: 120_000,
    connect: { timeout: 10_000 }
  });
  return {
    dispatcher,
    fetch: (url, init = {}) => undiciFetch(url, { ...init, dispatcher }),
    close: () => dispatcher.close()
  };
}
