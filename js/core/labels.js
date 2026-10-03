/* Vocabulaire centralisé : un seul endroit pour les libellés, définitions et statuts.
   Règles : « abonnés » (jamais « followers ») ; « abonnements » = following ; aucun vocabulaire « démo / réel ». */
const Api = window.Api;

export const PLATFORMS = Api.PLATFORMS;
export const PLATFORM_LABELS = Api.PLATFORM_LABELS;
export const VIEW_LABELS = Api.VIEW_LABELS;

export const L = {
  followers: 'Abonnés', following: 'Abonnements', followersLower: 'abonnés', newFollowers: 'Nouveaux abonnés (net)', unfollows: 'Désabonnements',
  interactions: 'Interactions', engagement: "Taux d'engagement", likes: "J'aime", comments: 'Commentaires', shares: 'Partages', saves: 'Enregistrements',
  posts: 'Publications', refresh: 'Actualiser', unavailable: 'Indisponible'
};

/** Définition affichée dans l'InfoTip « Interactions ». */
export const INTERACTIONS_DEF = "Interactions = j'aime + commentaires + partages (+ enregistrements si la plateforme les fournit).";

/** « vs 30 j précédents » */
export const periodVs = (period) => `vs ${period} j précédents`;

/** Formule du taux d'engagement : `basis` vient de l'API (engagementBasis par publication, kpiEngagementBasis pour le KPI de compte). */
export function engagementFormula(basis) {
  return basis || "Taux d'engagement = interactions ÷ audience (portée, vues ou impressions selon la plateforme) × 100.";
}

/** Libellé de la métrique d'audience par plateforme. */
export const viewLabel = (platform) => VIEW_LABELS[platform] || 'Vues';
export const likesLabel = (platform) => (platform === 'linkedin' ? 'Réactions' : "J'aime");
export const sharesLabel = (platform) => (platform === 'linkedin' ? 'Republications' : 'Partages');

export const SENT = { positive: 'Positif', neutral: 'Neutre', negative: 'Négatif' };
export const TIMEFRAMES = { this_week: 'cette semaine', this_month: 'ce mois-ci', last_14_days: '14 derniers jours', last_30_days: '30 derniers jours', last_90_days: '90 derniers jours', prev_month: 'mois précédent' };

export const REASONS = {
  not_configured: "identifiants de l'application absents côté serveur (voir connexion.md)",
  invalid_state: 'requête expirée ou invalide, recommencez',
  denied: 'autorisation refusée',
  missing_code: 'réponse incomplète de la plateforme',
  token_exchange: "échange du code refusé par la plateforme (vérifiez l'URL de redirection et les secrets)",
  pending_approval: "en attente d'approbation LinkedIn (Community Management API)"
};

export const STATUS_LABEL = {
  connected: 'Connecté', not_configured: 'Non configuré', error: 'Erreur', done: 'Réussi', running: 'En cours', pending: 'En attente',
  unknown: 'Résultat indisponible', idle: 'Au repos', not_connected: 'Déconnecté', healthy: 'En ligne', active: 'En ligne', failed: 'Échec',
  cancelled: 'Annulé', stale: 'Mesure ancienne', unavailable: 'Indisponible', expired: 'Expirée', limited: 'Limité', pending_approval: 'En attente d’approbation'
};
export const statusLabel = (s) => STATUS_LABEL[s] || s || 'Indisponible';

/** Statut brut (API) → famille visuelle de StatusBadge. Le vert n'est jamais un statut. */
export const STATUS_KIND = {
  done: 'ok', connected: 'ok', healthy: 'ok', active: 'ok', available: 'ok',
  failed: 'error', error: 'error', expired: 'error', network: 'error', permission: 'error', incompatible_response: 'error', auth: 'error', http: 'error', configuration: 'error',
  stale: 'warn', no_data: 'warn', limited: 'warn', incomplete_config: 'warn',
  running: 'pending', pending: 'pending', pending_approval: 'pending',
  unsupported: 'info'
};
export const statusKind = (s) => STATUS_KIND[s] || 'neutral';

export const MON_LABEL = { available: 'Disponible', not_configured: 'Non configuré dans Dokploy', incomplete_config: 'Configuration incomplète', unsupported: 'Non pris en charge par cette version', permission: 'Droits insuffisants', network: 'Agent injoignable', incompatible_response: 'Réponse inattendue', no_data: 'Aucune mesure reçue', stale: 'Mesure ancienne', unknown: 'État indéterminé' };
export const CONN_LABEL = { connected: 'Connecté', not_configured: 'Non configurée', auth: 'Clé API refusée', network: 'Injoignable', configuration: 'Configuration invalide', http: 'Erreur de l’API' };
export const TYPE_LABEL = { application: 'Application', compose: 'Compose', postgres: 'PostgreSQL', mysql: 'MySQL', mariadb: 'MariaDB', mongo: 'MongoDB', redis: 'Redis' };

/** Libellés de jeton (santé, actions, infobulles) : une seule source, js/core/token-logic.js (module pur, testé). */
export { TOKEN_TEXT, tokenBadge, attentionBadge } from './token-logic.js?v=15';
