// Lecture et validation de la configuration (variables d'environnement).
// Fail-closed : sans secrets valides, le serveur refuse de démarrer.
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

const bool = (v, def = false) => (v === undefined || v === '' ? def : ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase()));
const int = (v, def) => {
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : def;
};

/** Entier borné : valeur absente ou invalide -> défaut ; valeur hors bornes -> ramenée dans [min, max]. */
const intIn = (v, def, min, max) => {
  const n = Number.parseInt(v, 10);
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, n));
};
const oneOf = (v, allowed, def) => {
  const s = String(v ?? '').trim();
  const hit = allowed.find((a) => a.toLowerCase() === s.toLowerCase());
  return hit || def;
};

// Conformité LinkedIn : l'activité sociale de membres (commentaires) ne reste jamais plus de 48 h en cache.
export const LINKEDIN_COMMENTS_RETENTION_HOURS = 48;
// Planchers du mode en direct (secondes).
export const LIVE_MIN_LIGHT_SECONDS = 15;
export const LIVE_MIN_HEAVY_SECONDS = 60;

function findMockPath(explicit) {
  const candidates = [explicit, '/app/mock/mock.js', path.resolve(here, '../../data/mock.js')].filter(Boolean);
  return candidates.find((p) => fs.existsSync(p)) || null;
}

export class ConfigError extends Error {}

export function loadConfig(env = process.env) {
  const publicUrl = String(env.PUBLIC_URL || 'http://localhost:8080').replace(/\/+$/, '');
  const cfg = {
    nodeEnv: env.NODE_ENV || 'production',
    port: int(env.PORT, 3000),
    host: env.HOST || '0.0.0.0',
    publicUrl,
    secureCookies: env.COOKIE_SECURE !== undefined ? bool(env.COOKIE_SECURE) : publicUrl.startsWith('https://'),
    dataDir: env.DATA_DIR || '/data',

    dashboardPassword: env.DASHBOARD_PASSWORD || '',
    sessionSecret: env.SESSION_SECRET || '',
    tokenEncryptionKey: env.TOKEN_ENCRYPTION_KEY || '',
    sessionTtlHours: intIn(env.SESSION_TTL_HOURS, 12, 1, 24),
    maxSessions: intIn(env.MAX_SESSIONS, 10, 1, 100),

    loginMaxAttempts: int(env.LOGIN_MAX_ATTEMPTS, 5),
    loginWindowMinutes: int(env.LOGIN_WINDOW_MINUTES, 15),

    cacheTtlSeconds: int(env.CACHE_TTL_SECONDS, 900),
    refreshIntervalHours: int(env.REFRESH_INTERVAL_HOURS, 6),
    mockFallback: false, // Données de démonstration interdites en production comme en développement.
    persistCache: bool(env.PERSIST_CACHE, true), // cache.enc.json chiffré (jeu de données, jamais commentaires ni jetons)
    // Âge maximal d'une entrée du cache persistant : au-delà, elle est purgée au démarrage au lieu d'être réaffichée.
    persistCacheMaxAgeDays: intIn(env.PERSIST_CACHE_MAX_AGE_DAYS, 7, 1, 30),
    // Mode « en direct » : actualisation rapide uniquement tant que l'application est ouverte (présence).
    // Planchers : une valeur trop basse par erreur de configuration ne doit jamais dépasser les quotas fournisseurs.
    live: {
      enabled: bool(env.LIVE_ENABLED, true),
      activeWindowSeconds: intIn(env.LIVE_ACTIVE_WINDOW_SECONDS, 90, 30, 900),
      instagramLightSeconds: intIn(env.LIVE_INSTAGRAM_LIGHT_SECONDS, 60, LIVE_MIN_LIGHT_SECONDS, 3600),
      instagramHeavySeconds: intIn(env.LIVE_INSTAGRAM_HEAVY_SECONDS, 900, LIVE_MIN_HEAVY_SECONDS, 86_400),
      tiktokLightSeconds: intIn(env.LIVE_TIKTOK_LIGHT_SECONDS, 90, LIVE_MIN_LIGHT_SECONDS, 3600),
      tiktokHeavySeconds: intIn(env.LIVE_TIKTOK_HEAVY_SECONDS, 900, LIVE_MIN_HEAVY_SECONDS, 86_400),
      dokployMetricsTtlMs: intIn(env.LIVE_DOKPLOY_METRICS_TTL_MS, 2000, 1000, 60_000),
      dokployStatusTtlMs: intIn(env.LIVE_DOKPLOY_STATUS_TTL_MS, 5000, 1000, 60_000),
      dokployRunningTtlMs: 3000,
      rateLimitPerMinute: intIn(env.LIVE_RATE_LIMIT_PER_MINUTE, 90, 30, 600)
    },
    dokploy: {
      url: String(env.DOKPLOY_URL || "").replace(/\/+$/, ""),
      apiKey: env.DOKPLOY_API_KEY || "",
      // Liste blanche des actions (redéployer/recharger) : ID de service, ID ou nom de projet, séparés par des virgules. Vide = tous les services visibles.
      actionAllowlist: String(env.DOKPLOY_ACTION_ALLOWLIST || '').split(',').map((v) => v.trim()).filter(Boolean),
      // false = aucun journal de déploiement n'est relu ni affiché (données critiques).
      logsEnabled: bool(env.DOKPLOY_LOGS_ENABLED, true),
      // Valeurs exactes à masquer dans les journaux relayés (secrets de cette API) ; jamais exposées.
      secretValues: [env.DOKPLOY_API_KEY, env.SESSION_SECRET, env.TOKEN_ENCRYPTION_KEY, env.DASHBOARD_PASSWORD,
        env.TIKTOK_CLIENT_SECRET, env.INSTAGRAM_APP_SECRET, env.LINKEDIN_CLIENT_SECRET].filter((v) => typeof v === 'string' && v.length >= 8)
    },
    mockPath: findMockPath(env.MOCK_DATA_PATH),

    tiktok: {
      clientKey: env.TIKTOK_CLIENT_KEY || '',
      clientSecret: env.TIKTOK_CLIENT_SECRET || '',
      redirectUri: env.TIKTOK_REDIRECT_URI || `${publicUrl}/api/auth/tiktok/callback`,
      scopes: env.TIKTOK_SCOPES || 'user.info.basic,user.info.profile,user.info.stats,video.list',
      retryDelayMs: intIn(env.TIKTOK_RETRY_DELAY_MS, 500, 0, 10_000)
    },
    instagram: {
      appId: env.INSTAGRAM_APP_ID || '',
      appSecret: env.INSTAGRAM_APP_SECRET || '',
      redirectUri: env.INSTAGRAM_REDIRECT_URI || `${publicUrl}/api/auth/instagram/callback`,
      scopes: env.INSTAGRAM_SCOPES || 'instagram_business_basic,instagram_business_manage_insights,instagram_business_manage_comments',
      graphVersion: env.INSTAGRAM_GRAPH_VERSION || 'v23.0',
      insightMediaMax: intIn(env.INSTAGRAM_INSIGHT_MEDIA_MAX, 120, 1, 500),
      commentMediaMax: intIn(env.INSTAGRAM_COMMENT_MEDIA_MAX, 30, 0, 200),
      insightConcurrency: intIn(env.INSTAGRAM_INSIGHT_CONCURRENCY, 5, 1, 10)
    },
    linkedin: {
      clientId: env.LINKEDIN_CLIENT_ID || '',
      clientSecret: env.LINKEDIN_CLIENT_SECRET || '',
      redirectUri: env.LINKEDIN_REDIRECT_URI || `${publicUrl}/api/auth/linkedin/callback`,
      organizationId: (env.LINKEDIN_ORGANIZATION_ID || '').replace(/^urn:li:organization:/, ''),
      communityApi: bool(env.LINKEDIN_COMMUNITY_API, false),
      apiVersion: env.LINKEDIN_API_VERSION || '202609', // version « Latest » de la doc au 30/09/2026 (202510 retirée le 15/10/2026)
      scopes: env.LINKEDIN_SCOPES || '',
      dailyCallBudget: intIn(env.LINKEDIN_DAILY_CALL_BUDGET, 80, 0, 100), // quota Development tier : 100 appels/jour/membre
      priorityReserve: undefined, // calculé ci-dessous (dépend du budget)
      maxPostPages: intIn(env.LINKEDIN_MAX_POST_PAGES, 5, 1, 20),
      pageStatsDays: intIn(env.LINKEDIN_PAGE_STATS_DAYS, 90, 1, 365),
      pageStatsGranularity: oneOf(env.LINKEDIN_PAGE_STATS_GRANULARITY, ['DAY', 'MONTH'], 'DAY'),
      reactionsMaxPosts: intIn(env.LINKEDIN_REACTIONS_MAX_POSTS, 15, 0, 100),
      commentsMaxPosts: intIn(env.LINKEDIN_COMMENTS_MAX_POSTS, 15, 0, 100),
      shareStatsListStyle: oneOf(env.LINKEDIN_SHARE_STATS_LIST_STYLE, ['list', 'indexed'], 'list'),
      // Cache dédié : LinkedIn est limité par un budget d'appels quotidien, on ne relit pas toutes les 15 min.
      // Plafonné à 48 h : le cache contient les commentaires de membres.
      cacheTtlSeconds: intIn(env.LINKEDIN_CACHE_TTL_SECONDS, 12 * 3600, 60, LINKEDIN_COMMENTS_RETENTION_HOURS * 3600),
      // Intervalle minimal entre deux relectures PÉRIODIQUES (le rafraîchissement manuel reste soumis au budget).
      refreshIntervalHours: intIn(env.LINKEDIN_REFRESH_INTERVAL_HOURS, 12, 1, 168)
    }
  };
  // Le palier lourd n'est jamais plus fréquent que le léger.
  const lv = cfg.live;
  lv.instagramHeavySeconds = Math.max(lv.instagramHeavySeconds, lv.instagramLightSeconds);
  lv.tiktokHeavySeconds = Math.max(lv.tiktokHeavySeconds, lv.tiktokLightSeconds);
  // Même défaut que le fournisseur : un tiers du budget, 25 au plus (appels de détail « tier 2 » bloqués au-delà).
  cfg.linkedin.priorityReserve = intIn(env.LINKEDIN_PRIORITY_RESERVE, Math.min(25, Math.floor(cfg.linkedin.dailyCallBudget / 3)), 0, cfg.linkedin.dailyCallBudget);
  // Scopes par défaut (vérifiés sur learn.microsoft.com, 09/2026) :
  //  - rw_organization_admin : organizations/{id}, networkSizes, organizationalEntityFollowerStatistics,
  //                            organizationalEntityShareStatistics (rôle ADMINISTRATOR de la Page)
  //  - r_organization_social : posts?q=author (Posts API)
  // Les commentaires (socialActions/comments) exigent r_organization_social_feed : à ajouter dans
  // LINKEDIN_SCOPES uniquement s'il apparaît dans l'onglet Auth de l'app après approbation.
  // Avant approbation (LINKEDIN_COMMUNITY_API=false), AUCUN scope n'est demandé : l'OAuth LinkedIn est bloqué.
  if (!cfg.linkedin.scopes) cfg.linkedin.scopes = 'r_organization_social rw_organization_admin';
  return cfg;
}

/** Vérifie les secrets obligatoires. Lève ConfigError avec un message clair (sans jamais afficher les valeurs). */
export function assertSecrets(cfg) {
  const problems = [];
  const missing = [
    ['DASHBOARD_PASSWORD', cfg.dashboardPassword],
    ['SESSION_SECRET', cfg.sessionSecret],
    ['TOKEN_ENCRYPTION_KEY', cfg.tokenEncryptionKey]
  ].filter(([, v]) => !v).map(([k]) => k);
  if (missing.length) problems.push(`Variable(s) obligatoire(s) ABSENTE(S) ou vide(s) : ${missing.join(', ')}.`);
  if (cfg.dashboardPassword && cfg.dashboardPassword.length < 12) problems.push('DASHBOARD_PASSWORD doit contenir au moins 12 caractères.');
  if (cfg.sessionSecret && cfg.sessionSecret.length < 32) problems.push('SESSION_SECRET doit contenir au moins 32 caractères (openssl rand -hex 32).');
  if (cfg.tokenEncryptionKey && !/^[0-9a-fA-F]{64}$/.test(cfg.tokenEncryptionKey)) problems.push('TOKEN_ENCRYPTION_KEY doit être 64 caractères hexadécimaux (openssl rand -hex 32).');
  const placeholder = (v) => /remplacez|a-generer|changeme|example|exemple/i.test(v) || /^(.)\1+$/.test(v);
  ['dashboardPassword', 'sessionSecret', 'tokenEncryptionKey'].forEach((k) => {
    if (cfg[k] && placeholder(cfg[k])) problems.push(`${{ dashboardPassword: 'DASHBOARD_PASSWORD', sessionSecret: 'SESSION_SECRET', tokenEncryptionKey: 'TOKEN_ENCRYPTION_KEY' }[k]} contient une valeur d'exemple : générez une vraie valeur.`);
  });
  if (cfg.sessionSecret && cfg.sessionSecret === cfg.tokenEncryptionKey) problems.push('SESSION_SECRET et TOKEN_ENCRYPTION_KEY doivent être différents.');
  if (cfg.dashboardPassword && [cfg.sessionSecret, cfg.tokenEncryptionKey].includes(cfg.dashboardPassword)) problems.push('DASHBOARD_PASSWORD doit être différent de SESSION_SECRET et TOKEN_ENCRYPTION_KEY.');
  if (problems.length) {
    throw new ConfigError(
      '[api] Configuration invalide, arrêt (le site statique reste servi par le service web) :\n - ' + problems.join('\n - ') +
      '\n → Renseignez ces variables dans Dokploy > votre Compose > Environment (voir .env.example), puis Redeploy.'
    );
  }
}

/**
 * Avertissements NON bloquants (le démarrage continue) : robustesse du mot de passe, liste d'actions Dokploy.
 * Ne renvoie jamais de valeur secrète.
 */
export function securityWarnings(cfg) {
  const out = [];
  const pw = cfg.dashboardPassword || '';
  const classes = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((re) => re.test(pw)).length;
  if (pw && pw.length < 20 && classes < 3) out.push('DASHBOARD_PASSWORD est court et peu varié : préférez une phrase de passe de 20 caractères ou plus (voir npm run check-password).');
  if (!cfg.dokploy.actionAllowlist.length && cfg.dokploy.url) out.push('DOKPLOY_ACTION_ALLOWLIST vide : les actions sont possibles sur tous les services visibles par la clé Dokploy.');
  return out;
}

/** Une plateforme est "configurée" si ses identifiants d'app sont renseignés. */
export function platformConfigured(cfg, platform) {
  switch (platform) {
    case 'tiktok': return Boolean(cfg.tiktok.clientKey && cfg.tiktok.clientSecret);
    case 'instagram': return Boolean(cfg.instagram.appId && cfg.instagram.appSecret);
    case 'linkedin': return Boolean(cfg.linkedin.clientId && cfg.linkedin.clientSecret);
    default: return false;
  }
}
