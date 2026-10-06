import { randomUUID } from 'node:crypto';
import { NativeDokploy, nativeMetrics } from './dokploy-native.js';

// Erreur exposable au navigateur : message français sans secret. `reason` distingue auth / network / configuration / http.
export class DokployError extends Error {
  constructor(status, code, message, reason = 'http', httpStatus = null) { super(message); Object.assign(this, { status, code, reason, httpStatus }); Object.defineProperty(this, 'remote', { value: '', writable: true, enumerable: false }); }
}

export const str = (v) => typeof v === 'string' ? v.slice(0, 240) : null;
export const list = (v) => Array.isArray(v) ? v : [];
const TYPES = ['application', 'compose', 'postgres', 'mysql', 'mariadb', 'mongo', 'redis'];
export const REDEPLOY_TYPES = ['application', 'compose'];
export const ID_RE = /^[A-Za-z0-9_-]{1,100}$/;
const APPNAME_RE = /^[a-zA-Z0-9._-]{1,63}$/;   // appName Dokploy 0.30.8 (1-63 caractères)
const RELOAD_TIMEOUT_MS = 60_000;   // application.reload est synchrone côté Dokploy
const RELOAD_POLL_TRIES = 5;
const RELOAD_POLL_MS = 2_000;

// Endpoints vérifiés dans Dokploy v0.30.8 (aucune dépendance au document OpenAPI).
const ROUTES = {
  'settings.getDokployVersion': 'GET', 'project.all': 'GET', 'project.one': 'GET',
  'deployment.all': 'GET', 'deployment.allByCompose': 'GET', 'deployment.readLogs': 'GET',
  'application.redeploy': 'POST', 'compose.redeploy': 'POST', 'application.reload': 'POST',
  'user.getMetricsToken': 'GET', 'server.getServerMetrics': 'GET', 'application.readAppMonitoring': 'GET',
  'settings.getOpenApiDocument': 'GET'
};

// Seules deux versions exactes ont été vérifiées à la source : readLogs ABSENT en 0.26.5, PRÉSENT en 0.30.8.
// Aucune extrapolation (ni « <= » ni « >= ») : toute autre version reste « inconnue ».
const LOGS_ABSENT_VERSION = '0.26.5';
const LOGS_PRESENT_VERSION = '0.30.8';
const SCHEMA_OK_TTL_MS = 3_600_000;
const SCHEMA_FAIL_TTL_MS = 120_000;
const SCHEMA_MAX_BYTES = 25_000_000;

const CONCURRENCY = 5;            // lectures simultanées vers Dokploy
const BUDGET_MS = 20_000;         // budget global d'un snapshot (< timeout frontend de 25 s)
const REQUEST_TIMEOUT_MS = 12_000;
const OK_TTL_MS = 15_000;
const ERROR_TTL_MS = 5_000;
const METRICS_MAX_AGE_MS = 5 * 60_000;
const HISTORY_PER_SERVICE = 50;   // renvoyé au navigateur
const KNOWN_PER_SERVICE = 200;    // identifiants acceptés pour la lecture des logs
const KNOWN_MAX = 5000;
const OPERATIONS_MAX = 100;
const OPERATION_TTL_MS = 600_000;
const FINISHED_TTL_MS = 3_600_000;
const LOG_LINES = 200;
const LOG_BYTES = 64 * 1024;

// Monitoring du VPS : `status` ∈ available | not_configured | incomplete_config | unsupported | permission | network | incompatible_response | no_data | stale | unknown.
export const emptyServer = (status = 'unknown', reason = null, message = null) => ({ status, scope: 'vps', observedAt: null, reason, message, cpuPercent: null, ramUsedBytes: null, ramTotalBytes: null, storageUsedBytes: null, storageTotalBytes: null });

export const MON = {
  not_configured: 'Monitoring non configuré dans Dokploy : aucun jeton ni URL de rappel n’y est enregistré. Configurez-le dans Dokploy si vous souhaitez afficher les ressources du VPS.',
  incomplete_token: 'Configuration du monitoring incomplète dans Dokploy : le jeton est absent.',
  incomplete_host: 'Configuration du monitoring incomplète dans Dokploy : adresse du serveur ou port absent ou invalide.',
  agent_token: 'L’agent de monitoring paraît refuser le jeton enregistré dans Dokploy : vérifiez la configuration du monitoring.',
  unsupported: 'Cette version de Dokploy ne semble pas exposer le monitoring via l’API.',
  permission: 'Droits insuffisants pour lire le monitoring : Dokploy a refusé l’accès (clé invalide ou permission de monitoring manquante).',
  network_agent: 'Agent de monitoring injoignable depuis Dokploy (agent absent, arrêté ou port fermé). Cela ne prouve pas que le monitoring soit désactivé.',
  network_dokploy: 'Dokploy injoignable lors de la lecture du monitoring.',
  incompatible: 'Réponse du monitoring dans un format inattendu : aucune mesure exploitable.',
  no_data: 'Aucune mesure reçue pour le moment : l’agent n’a pas encore transmis de données.',
  stale: 'Dernière mesure ancienne (plus de 5 min) : vérifiez l’agent de monitoring.',
  stale_unknown: 'Fraîcheur de la mesure inconnue : horodatage absent ou illisible.',
  unknown: 'État du monitoring indéterminé : Dokploy a renvoyé une erreur inattendue.',
  not_checked: 'Monitoring non vérifié : la connexion à l’API Dokploy n’est pas établie.'
};

const MESSAGES = {
  auth: 'Clé API Dokploy refusée (401/403) : clé invalide ou droits insuffisants.',
  network: 'Dokploy injoignable : vérifiez DOKPLOY_URL et la connexion réseau du backend.'
};

/** Valide DOKPLOY_URL : pas d'identifiants, pas de /api, http réservé aux hôtes privés. Renvoie { url } ou { error }. */
export function checkDokployUrl(raw) {
  let base;
  try { base = new URL(raw); } catch { return { error: 'URL invalide.' }; }
  if (!['http:', 'https:'].includes(base.protocol)) return { error: 'Le protocole doit être https.' };
  if (base.username || base.password) return { error: 'Les identifiants dans l’URL sont interdits.' };
  if (base.search || base.hash) return { error: 'Paramètres ou fragment interdits dans l’URL.' };
  if (/(^|\/)api(\/|$)/i.test(base.pathname)) return { error: 'N’indiquez pas le chemin /api.' };
  if (base.protocol === 'http:' && !isPrivateHost(base.hostname)) return { error: 'http:// est refusé hors réseau privé ou localhost : utilisez https.' };
  return { url: base };
}

function isPrivateHost(host) {
  const h = host.replace(/^\[|\]$/g, '').toLowerCase();
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal')) return true;
  if (h === '::1' || /^f[cd][0-9a-f]{2}:/.test(h) || /^fe80:/.test(h)) return true;
  const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m) { const [a, b] = [Number(m[1]), Number(m[2])]; return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254); }
  return !h.includes('.') && !h.includes(':'); // nom de service Docker ou hôte local sans domaine
}

// ---------------------------------------------------------------------------
// Expurgation des logs : ne renvoie que du texte masqué par motifs.
// ---------------------------------------------------------------------------
const MASK = '[masqué]';
const KEY_WORDS = 'secret|token|passw(?:or)?d|passwd|pwd|key|credential|auth|private|cert';

export function redactLogs(input) {
  let text = String(input ?? '').slice(-4 * LOG_BYTES);
  text = text
    .replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g, '')       // OSC
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '')                        // CSI (couleurs, curseur)
    .replace(/\r(?!\n)/g, '\n')
    .replace(/-----BEGIN [A-Z0-9 ]+-----[\s\S]*?(?:-----END [A-Z0-9 ]+-----|$)/g, '[bloc PEM masqué]')
    .replace(/(authorization\s*[:=]\s*)(?:(?:bearer|basic|token)\s+)?[^\s"',;]+/gi, `$1${MASK}`)
    .replace(/\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, `$1 ${MASK}`)
    .replace(/(x-api-key\s*[:=]\s*)[^\s"',;]+/gi, `$1${MASK}`)
    .replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^/\s@]+@/gi, `$1${MASK}@`)
    .replace(new RegExp(`(["']?[\\w.-]*(?:${KEY_WORDS})[\\w.-]*["']?\\s*[:=]\\s*)(?:("[^"]*")|('[^']*')|[^\\s,;&}"']+)`, 'gi'), (_m, key, dq, sq) => `${key}${dq ? `"${MASK}"` : sq ? `'${MASK}'` : MASK}`)
    .replace(/\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|glpat-[A-Za-z0-9_-]{16,}|sk-[A-Za-z0-9_-]{16,}|AKIA[0-9A-Z]{16}|xox[baprs]-[A-Za-z0-9-]{10,}|AIza[0-9A-Za-z_-]{30,})/g, MASK)
    .replace(/[A-Za-z0-9+/_=-]{32,}/g, (token) => {
      if (/^[a-f0-9]{32,}$/i.test(token)) return MASK;
      if ((token.match(/\//g) || []).length >= 3) return token;           // chemin plutôt que jeton
      return /[A-Za-z]/.test(token) && /\d/.test(token) ? MASK : token;
    });
  const lines = text.split('\n');
  const truncatedLines = lines.length > LOG_LINES;
  let out = lines.slice(-LOG_LINES).join('\n');
  const truncatedBytes = out.length > LOG_BYTES;
  if (truncatedBytes) out = out.slice(-LOG_BYTES);
  return { text: out.trim(), truncated: truncatedLines || truncatedBytes };
}

async function pool(items, limit, fn) {
  const out = new Array(items.length); let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) { const i = next++; out[i] = await fn(items[i], i); }
  }));
  return out;
}

export const mapStatus = (status) => ({ done: 'done', error: 'error', cancelled: 'cancelled' })[String(status).toLowerCase()] || 'running';
const isActive = (op) => ['pending', 'running'].includes(op.status);

// ---------------------------------------------------------------------------
// Services : projection par allowlist (jamais la ligne brute, qui peut contenir env, mots de passe, jetons…).
// ---------------------------------------------------------------------------
const SERVICE_LISTS = { application: 'applications', compose: 'compose', postgres: 'postgres', mysql: 'mysql', mariadb: 'mariadb', mongo: 'mongo', redis: 'redis' };
const idOf = (v) => typeof v === 'string' || typeof v === 'number' ? str(String(v)) : null;
const UNKNOWN = { project: 'Projet inconnu', environment: 'Environnement inconnu', service: 'Service inconnu' };
export const contextOf = ({ projectName, environmentName, serviceName }) => [projectName || UNKNOWN.project, environmentName || UNKNOWN.environment, serviceName || UNKNOWN.service].join(' → ');

/** Extrait les services d'une ligne de projet (project.all / project.one) vers des objets à champs autorisés uniquement. */
export function extractServices(project, { projectId, projectName }) {
  const out = [];
  const groups = [{ row: project, env: null }, ...list(project?.environments).slice(0, 50).map((row) => ({ row, env: row }))];
  for (const { row, env } of groups) {
    if (!row || typeof row !== 'object') continue;
    const environmentId = env ? idOf(env.environmentId ?? env.id) : null, environmentName = env ? str(env.name) : null;
    for (const [type, key] of Object.entries(SERVICE_LISTS)) for (const item of list(row[key]).slice(0, 100)) {
      const bare = typeof item === 'string';           // 0.30.x : les bases ne renvoient parfois que l'identifiant
      if (!bare && (!item || typeof item !== 'object')) continue;
      const id = bare ? idOf(item) : idOf(item[`${type}Id`] ?? item.id);
      if (!id) continue;
      out.push({
        id, type, name: bare ? null : str(item.name), appName: bare ? null : str(item.appName),
        status: bare ? null : str(item[type === 'compose' ? 'composeStatus' : 'applicationStatus'] ?? item.status),
        serverId: bare ? null : idOf(item.serverId),
        projectId, projectName, environmentId: environmentId ?? (bare ? null : idOf(item.environmentId)), environmentName
      });
    }
  }
  return out;
}

// Fusionne deux lectures du même service (project.one puis project.all) : le premier champ non nul l'emporte.
function mergeServices(...groups) {
  const byKey = new Map();
  for (const item of groups.flat()) {
    const key = `${item.type}:${item.id}`, prev = byKey.get(key);
    if (!prev) byKey.set(key, { ...item });
    else for (const [field, value] of Object.entries(item)) if (prev[field] === null || prev[field] === undefined) prev[field] = value;
  }
  return [...byKey.values()];
}

// Un message d'erreur de déploiement n'est montré que s'il est déjà sûr (aucun motif sensible, aucun chemin absolu).
export function safeErrorMessage(value) {
  if (typeof value !== 'string' || !value.trim()) return { text: null, hidden: false };
  const clean = value.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim();
  const safe = clean.length <= 300 && !/(^|[\s"'=(])\/[\w.-]+\/[\w./-]+/.test(clean) && redactLogs(clean).text === clean;
  return safe ? { text: clean, hidden: false } : { text: null, hidden: true };
}

// Normalise « v0.26.5 » / « 0.26.5 » en « 0.26.5 » ; toute autre forme (canary, suffixe, texte) donne null.
export function normalizeVersion(raw) {
  const m = typeof raw === 'string' ? raw.trim().match(/^v?(\d+)\.(\d+)\.(\d+)$/i) : null;
  return m ? `${Number(m[1])}.${Number(m[2])}.${Number(m[3])}` : null;
}

const logsUnsupportedMessage = (version) => `${version ? `Dokploy ${/^v/i.test(version) ? version : `v${version}`}` : 'Cette version de Dokploy'} ne fournit pas la lecture des journaux via l’API. Consultez-les dans Dokploy.`;

/** Capacités : présence des chemins OpenAPI (priorité 1), puis version semver, sinon « unknown ». */
export function detectCapabilities(version, paths) {
  const caps = { deploymentLogs: 'unknown', deploymentLogsSource: 'unknown', deploymentLogsReason: 'Capacité de lecture des journaux inconnue : schéma OpenAPI inaccessible et version non concluante.', monitoring: 'unknown', nativeMonitoring: 'unknown', deploymentLogsTransport: 'rest', reload: 'unknown', reloadReason: null, schema: paths ? 'available' : 'unavailable', version: version || null };
  if (paths) {
    const has = paths.has('deployment.readLogs');
    Object.assign(caps, { deploymentLogs: has ? 'supported' : 'unsupported', deploymentLogsSource: 'openapi', deploymentLogsReason: has ? 'Chemin deployment.readLogs présent dans le schéma OpenAPI de Dokploy.' : logsUnsupportedMessage(version) });
    caps.reload = paths.has('application.reload') ? 'supported' : 'unsupported';
    if (caps.reload === 'unsupported') caps.reloadReason = 'Cette version de Dokploy n’expose pas le rechargement d’une application via l’API.';
    caps.nativeMonitoring = paths.has('application.readAppMonitoring') ? 'supported' : 'unsupported';
    if (!has && normalizeVersion(version) === '0.26.5') Object.assign(caps, { deploymentLogs: 'supported', deploymentLogsSource: 'official_source', deploymentLogsTransport: 'websocket', deploymentLogsReason: 'Journaux via le WebSocket natif de Dokploy v0.26.5 ; transport authentifié côté backend.' });
    caps.monitoring = paths.has('user.getMetricsToken') && paths.has('server.getServerMetrics') ? 'supported' : 'unsupported';
    return caps;
  }
  const v = normalizeVersion(version);
  if (v === LOGS_ABSENT_VERSION) Object.assign(caps, { nativeMonitoring: 'supported', deploymentLogs: 'supported', deploymentLogsSource: 'official_source', deploymentLogsTransport: 'websocket', deploymentLogsReason: 'Journaux via le WebSocket natif de Dokploy v0.26.5 ; transport authentifié côté backend.' });
  else if (v === LOGS_PRESENT_VERSION) Object.assign(caps, { deploymentLogs: 'supported', deploymentLogsSource: 'version', deploymentLogsReason: 'Version v0.30.8 : lecture des journaux vérifiée à la source (non confirmée par le schéma de cette instance).' });
  else if (v) caps.deploymentLogsReason = `Version v${v} non vérifiée : la lecture des journaux peut exister ou non. Le bouton reste actif et les erreurs sont gérées.`;
  return caps;
}

export const NUM_MAX = (value, max = Infinity) => (typeof value === 'number' || (typeof value === 'string' && value.trim() !== '')) && Number.isFinite(Number(value)) && Number(value) >= 0 && Number(value) <= max ? Number(value) : null;

export class DokployClient {
  constructor(config = {}, { fetch = globalThis.fetch, now = () => Date.now(), sleep = (ms) => new Promise((r) => setTimeout(r, ms)), createSocket, native }  = {}) {
    this.config = config; this.fetch = fetch; this.now = now; this.sleep = sleep;
    this.operations = new Map(); this.knownDeployments = new Map();
    this.secretValues = new Set([config.apiKey, ...(config.secretValues || [])].filter((v) => typeof v === 'string' && v.length >= 4));
    this.versionCache = null; this.cache = null; this.inflight = null;
    this.native = native || new NativeDokploy({ url: config.url, apiKey: config.apiKey, now, ...(createSocket ? { createSocket } : fetch !== globalThis.fetch ? { createSocket: () => { throw new Error('Injected HTTP transport requires an injected websocket transport.'); } } : {}) });
  }
  close() { this.native.close(); this.secretValues.clear(); }
  rememberSecrets(raw) {
    let budget = 20000;
    const add = (v) => { if (typeof v === 'string' && v.length >= 4 && v.length <= 4096 && this.secretValues.size < 5000) this.secretValues.add(v); };
    const walk = (v, depth = 0) => {
      if (!v || typeof v !== 'object' || depth > 8 || budget-- <= 0) return;
      for (const [key, value] of Object.entries(v)) {
        if (/^(env|buildArgs|buildSecrets)$/i.test(key) && typeof value === 'string') for (const line of value.split('\n')) { const m = line.match(/^\s*[A-Za-z_][A-Za-z0-9_]*\s*=\s*(.*?)\s*$/); if (m) add(m[1].replace(/^(['"])(.*)\1$/, '$2')); }
        else if (/secret|password|token|apiKey|privateKey/i.test(key)) add(value);
        if (value && typeof value === 'object') walk(value, depth + 1);
      }
    }; walk(raw);
  }
  cleanLogs(text) {
    let filtered = String(text ?? '');
    for (const secret of this.secretValues) filtered = filtered.split(secret).join(MASK);
    return redactLogs(filtered);
  }
  get configured() { return Boolean(this.config.url && this.config.apiKey); }

  async request(endpoint, input = {}, method = 'GET', { deadline, maxBytes = 5_000_000, timeoutMs } = {}) {
    const checked = checkDokployUrl(this.config.url);
    if (!checked.url) throw new DokployError(503, 'dokploy_configuration', `Configuration Dokploy invalide : ${checked.error}`, 'configuration');
    const base = checked.url;
    const url = new URL(`${base.pathname.replace(/\/$/, '')}/api/${endpoint}`, base.origin);
    if (method === 'GET') for (const [key, value] of Object.entries(input)) url.searchParams.set(key, String(value));
    const timeout = timeoutMs ? timeoutMs : deadline ? Math.max(1000, Math.min(REQUEST_TIMEOUT_MS, deadline - this.now())) : REQUEST_TIMEOUT_MS;
    let response, body;
    try {
      response = await this.fetch(url, { method, redirect: 'error', signal: AbortSignal.timeout(timeout), headers: { 'x-api-key': this.config.apiKey, ...(method === 'POST' ? { 'Content-Type': 'application/json' } : {}) }, ...(method === 'POST' ? { body: JSON.stringify(input) } : {}) });
      body = await response.text();
    } catch { throw new DokployError(503, 'dokploy_unavailable', MESSAGES.network, 'network'); }
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) throw new DokployError(502, 'dokploy_auth', MESSAGES.auth, 'auth', response.status);
      const err = new DokployError(503, 'dokploy_unavailable', `Dokploy a répondu par une erreur (HTTP ${response.status}).`, 'http', response.status);
      // Message distant : usage interne uniquement (classification), jamais renvoyé au navigateur ni journalisé.
      try { const j = JSON.parse(body); err.remote = str(j?.message ?? j?.error?.message ?? j?.error?.json?.message) || ''; } catch { err.remote = ''; }
      throw err;
    }
    if (body.length > maxBytes) throw new DokployError(503, 'dokploy_unavailable', 'Réponse Dokploy trop volumineuse.', 'http');
    // Corps vide (ex. application.redeploy) → null ; chaîne JSON brute ("v0.30.8") ou texte brut tolérés.
    if (!body.trim()) return null;
    try { return JSON.parse(body); } catch { return body; }
  }

  async readVersion(deadline) {
    if (this.versionCache && this.versionCache.at + 300000 > this.now()) return this.versionCache.value;
    let value = null;
    try { const raw = await this.request('settings.getDokployVersion', {}, 'GET', { deadline }); value = str(typeof raw === 'string' ? raw : raw?.version); }
    catch (err) { if (['auth', 'network', 'configuration'].includes(err.reason)) throw err; }
    this.versionCache = { at: this.now(), value };
    return value;
  }

  supports(route, method = 'get') { return ROUTES[route] === method.toUpperCase(); }
  call(route, input = {}, method = 'GET', opts) {
    if (!this.supports(route, method)) throw new DokployError(503, 'dokploy_unsupported', 'Fonction indisponible sur cette version de Dokploy.');
    return this.request(route, input, method, opts);
  }

  dokployLink(service) {
    if (![service.projectId, service.environmentId, service.id].every((id) => typeof id === 'string' && ID_RE.test(id)) || !REDEPLOY_TYPES.includes(service.type)) return null;
    const checked = checkDokployUrl(this.config.url); if (!checked.url) return null;
    const u = checked.url; u.pathname = `${u.pathname.replace(/\/$/, '')}/dashboard/project/${service.projectId}/environment/${service.environmentId}/services/${service.type}/${service.id}`; u.search = '?tab=deployments'; return u.toString();
  }

  deployment(row, service) {
    const { text: errorMessage, hidden: errorMessageHidden } = safeErrorMessage(row.errorMessage);
    const startedAt = str(row.startedAt), finishedAt = str(row.finishedAt), createdAt = str(row.createdAt);
    const from = Date.parse(startedAt || createdAt), to = Date.parse(finishedAt);
    return {
      id: str(row.deploymentId), dokployUrl: this.dokployLink(service), serviceId: service.id, serviceName: service.name ?? null, serviceType: service.type ?? null,
      projectId: service.projectId ?? null, projectName: service.projectName ?? null, environmentId: service.environmentId ?? null, environmentName: service.environmentName ?? null,
      context: service.context ?? contextOf(service),
      status: str(row.status) ? mapStatus(row.status) : 'Indisponible', createdAt, startedAt, finishedAt,
      durationSeconds: Number.isFinite(from) && Number.isFinite(to) && to >= from ? Math.round((to - from) / 1000) : null,
      errorMessage, errorMessageHidden
    };
  }
  // Lecture ciblée de l'historique d'un seul service, triée du plus récent au plus ancien.
  async deploymentRows(type, id, opts) {
    const route = type === 'compose' ? 'deployment.allByCompose' : 'deployment.all';
    const rows = list(await this.call(route, { [`${type}Id`]: id }, 'GET', opts)).filter((row) => row && str(row.deploymentId));
    return rows.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  }
  remember(id, entry) {
    this.knownDeployments.delete(id); this.knownDeployments.set(id, entry);
    while (this.knownDeployments.size > KNOWN_MAX) this.knownDeployments.delete(this.knownDeployments.keys().next().value);
  }

  // Schéma OpenAPI : facultatif, mis en cache (1 h ; 2 min en cas d'échec), jamais bloquant. Ne conserve que les chemins.
  loadSchema(deadline) {
    if (this.schemaCache && this.schemaCache.until > this.now()) return Promise.resolve(this.schemaCache.paths);
    if (this.schemaInflight) return this.schemaInflight;
    this.schemaInflight = (async () => {
      let paths = null;
      try {
        const doc = await this.call('settings.getOpenApiDocument', {}, 'GET', { deadline, maxBytes: SCHEMA_MAX_BYTES });
        const keys = doc && typeof doc === 'object' && doc.paths && typeof doc.paths === 'object' ? Object.keys(doc.paths) : [];
        if (keys.length) paths = new Set(keys.map((k) => k.replace(/^\/+/, '').replace(/^api\//, '')));
      } catch { paths = null; }
      this.schemaCache = { until: this.now() + (paths ? SCHEMA_OK_TTL_MS : SCHEMA_FAIL_TTL_MS), paths };
      return paths;
    })().finally(() => { this.schemaInflight = null; });
    return this.schemaInflight;
  }
  async capabilities(deadline) {
    const [version, paths] = await Promise.all([this.versionCache?.value ?? null, this.loadSchema(deadline)]);
    return detectCapabilities(version, paths);
  }

  // Single-flight + cache court (15 s, 5 s en cas d'erreur).
  snapshot(force = false) {
    if (!this.configured) return Promise.resolve({ status: 'not_configured', version: null, connection: { status: 'not_configured', reason: 'configuration', message: 'Renseignez DOKPLOY_URL et DOKPLOY_API_KEY côté backend.' }, server: emptyServer('unknown', 'dokploy_not_configured', MON.not_checked), projects: [], services: [], deployments: [], capabilities: { redeploy: false, ...detectCapabilities(null, null) }, notes: ['Renseignez DOKPLOY_URL et DOKPLOY_API_KEY côté backend.'] });
    if (!force && this.cache && this.cache.until > this.now()) return Promise.resolve(this.cache.value);
    if (this.inflight) return this.inflight;
    this.inflight = this.build().then((value) => {
      this.cache = { until: this.now() + (value.status === 'connected' ? OK_TTL_MS : ERROR_TTL_MS), value };
      return value;
    }).finally(() => { this.inflight = null; });
    return this.inflight;
  }

  async build() {
    const deadline = this.now() + BUDGET_MS, opts = { deadline };
    const notes = ['Les ressources VPS proviennent du monitoring du serveur Dokploy local. Les ressources des conteneurs et des serveurs distants ne sont pas agrégées au VPS.'];
    try {
      const version = await this.readVersion(deadline);
      const caps = this.capabilities(deadline);   // ne rejette jamais ; la lecture des projets ne l'attend pas
      const raw = list(await this.call('project.all', {}, 'GET', opts)).filter((p) => p && typeof p === 'object' && str(p.projectId)).slice(0, 100);
      const projects = raw.map((p) => ({ id: str(p.projectId), name: str(p.name) || null }));
      const details = await pool(raw, CONCURRENCY, async (project) => {
        if (this.now() >= deadline) { notes.push('Lecture partielle : délai dépassé.'); return null; }
        try { return await this.call('project.one', { projectId: project.projectId }, 'GET', opts); } catch (err) { if (err.reason === 'auth') throw err; notes.push('Détails de certains projets indisponibles.'); return null; }
      });
      this.rememberSecrets(raw); this.rememberSecrets(details);
      const services = [];
      raw.forEach((row, index) => {
        const ctx = { projectId: projects[index].id, projectName: projects[index].name };
        services.push(...mergeServices(extractServices(details[index], ctx), extractServices(row, ctx)));
      });
      const seenIds = new Set();
      for (let i = services.length - 1; i >= 0; i--) { if (seenIds.has(services[i].id)) services.splice(i, 1); else seenIds.add(services[i].id); }
      const labelCount = new Map();
      for (const s of services) { s.context = contextOf({ projectName: s.projectName, environmentName: s.environmentName, serviceName: s.name }); labelCount.set(s.context, (labelCount.get(s.context) || 0) + 1); }
      for (const s of services) {
        // Deux services au contexte strictement identique : on ajoute un repère technique d'affichage (jamais utilisé comme identité).
        if (labelCount.get(s.context) > 1) s.context += ` · ${s.appName || `réf. ${s.id.slice(0, 8)}`}`;
        s.dokployUrl = this.dokployLink(s); s.serviceId = s.id; s.serviceName = s.name; s.canRedeploy = REDEPLOY_TYPES.includes(s.type) && ID_RE.test(s.id); s.canReload = false;
        s.status = s.status || 'Indisponible'; s.lastDeployment = null; s.containerMetrics = null;
      }
      services.sort((a, b) => a.context.localeCompare(b.context, 'fr'));
      const deployments = [];
      const histories = pool(services.filter((s) => REDEPLOY_TYPES.includes(s.type) && ID_RE.test(s.id)), CONCURRENCY, async (service) => {
        if (this.now() >= deadline) { notes.push('Historique partiel : délai de lecture dépassé.'); return; }
        try {
          const rows = (await this.deploymentRows(service.type, service.id, opts)).slice(0, KNOWN_PER_SERVICE);
          for (const row of rows) this.remember(row.deploymentId, { serviceId: service.id, serviceType: service.type, title: str(row.title), logPath: typeof row.logPath === 'string' ? row.logPath : null, serverId: service.serverId ?? null, dokployUrl: this.dokployLink(service) });
          const mapped = rows.slice(0, HISTORY_PER_SERVICE).map((row) => this.deployment(row, service));
          service.lastDeployment = mapped[0] || null; deployments.push(...mapped);
        } catch (err) { if (err.reason === 'auth') throw err; notes.push(`Historique indisponible pour ${service.context}.`); }
      });
      const [server] = await Promise.all([this.hostMetrics(deadline, caps), histories]);
      deployments.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
      const resolved = await caps;
      for (const s of services) s.canReload = s.type === 'application' && ID_RE.test(s.id) && typeof s.appName === 'string' && APPNAME_RE.test(s.appName) && resolved.reload !== 'unsupported';
      const capabilities = { redeploy: services.some((s) => s.canRedeploy), ...resolved };
      return { status: 'connected', version, connection: { status: 'connected', reason: null, message: null }, server, projects, services, deployments, capabilities, notes: [...new Set(notes)] };
    } catch (err) {
      const known = err instanceof DokployError;
      const message = known ? err.message : 'Lecture Dokploy impossible.';
      const reason = known ? err.reason : 'http';
      return { status: 'error', reason, version: this.versionCache?.value || null, connection: { status: 'error', reason, message }, server: emptyServer('unknown', 'dokploy_unreachable', MON.not_checked), projects: [], services: [], deployments: [], capabilities: { redeploy: false, ...detectCapabilities(this.versionCache?.value || null, null) }, notes: [message] };
    }
  }

  // Classe un échec de lecture du monitoring (Dokploy ne renvoie que des messages d'erreur génériques de l'agent : classification prudente).
  monitoringFailure(err, stage) {
    const remote = String(err?.remote || '');
    const off = (status, reason, message) => emptyServer(status, reason, message);
    if (err?.reason === 'auth') return off('permission', 'dokploy_forbidden', MON.permission);
    if (/no monitoring data/i.test(remote)) return off('no_data', 'empty_series', MON.no_data);
    if (/fetch failed/i.test(remote)) return off('network', 'agent_unreachable', MON.network_agent);
    if (/^error\s*(401|403)\b/i.test(remote)) return off('incomplete_config', 'agent_token_rejected', MON.agent_token);
    if (stage === 'config' && [404, 405].includes(err?.httpStatus)) return off('unsupported', 'route_absent', MON.unsupported);
    if (err?.reason === 'network') return off('network', 'dokploy_unreachable', MON.network_dokploy);
    return off('unknown', 'unexpected_error', MON.unknown);
  }

  async hostMetrics(deadline, capsPromise = null) {
    const caps = capsPromise ? await capsPromise : await this.capabilities(deadline);
    const agent = await this.agentMetrics(deadline, Promise.resolve(caps));
    if (agent.status === 'available' || caps.nativeMonitoring === 'unsupported' || agent.status === 'permission') return { ...agent, source: 'dokploy_agent', monitoringMode: 'snapshot' };
    try {
      const checked = checkDokployUrl(this.config.url);
      // Native websocket protocol was source-verified for this exact version only.
      if (checked.url && normalizeVersion(this.versionCache?.value) === '0.26.5') { this.native.watch(); const current = this.native.current(); if (current) return current; }
      const data = await this.call('application.readAppMonitoring', { appName: 'dokploy' }, 'GET', { deadline });
      const dto = nativeMetrics(data, this.now());
      if (dto.status === 'available') return dto;
      return { ...dto, message: `${dto.message} La configuration de l’agent et la collecte intégrée sont distinctes.` };
    } catch (err) {
      if (err.reason === 'auth') return emptyServer('permission', 'dokploy_forbidden', MON.permission);
      return { ...agent, source: 'dokploy_agent', monitoringMode: 'snapshot' };
    }
  }

  async agentMetrics(deadline, capsPromise = null) {
    const opts = { deadline };
    const off = (status, reason, message) => emptyServer(status, reason, message);
    const caps = capsPromise ? await capsPromise : null;
    if (caps?.monitoring === 'unsupported') return off('unsupported', 'route_absent', MON.unsupported);
    let config;
    try { config = await this.call('user.getMetricsToken', {}, 'GET', opts); }
    catch (err) { return this.monitoringFailure(err, 'config'); }
    // `enabledFeatures` est un indicateur de licence : jamais une preuve de monitoring, donc ignoré.
    const server = config?.metricsConfig?.server;
    if (!config || typeof config !== 'object' || !server || typeof server !== 'object') return off('incompatible_response', 'metrics_config_shape', MON.incompatible);
    const token = typeof server.token === 'string' ? server.token : '', callback = typeof server.urlCallback === 'string' ? server.urlCallback : '';
    if (!token && !callback) return off('not_configured', 'token_and_callback_empty', MON.not_configured);
    if (!token) return off('incomplete_config', 'token_missing', MON.incomplete_token);
    const host = config.serverIp, port = Number(server.port);
    if (typeof host !== 'string' || !/^[a-zA-Z0-9.:-]+$/.test(host) || !Number.isInteger(port) || port < 1 || port > 65535) return off('incomplete_config', 'host_or_port_missing', MON.incomplete_host);
    let rows;
    try {
      // Limite connue : le token de métriques voyage en query string vers Dokploy (voir connexion.md).
      const url = `http://${host.includes(':') ? `[${host}]` : host}:${port}/metrics`;
      rows = await this.call('server.getServerMetrics', { url, token, dataPoints: '1' }, 'GET', opts);
    } catch (err) { return this.monitoringFailure(err, 'metrics'); }
    if (!Array.isArray(rows)) return off('incompatible_response', 'not_an_array', MON.incompatible);
    if (!rows.length) return off('no_data', 'empty_series', MON.no_data);
    const row = rows.at(-1);   // l'agent renvoie l'ordre croissant : le dernier point est le plus récent
    if (!row || typeof row !== 'object') return off('incompatible_response', 'row_shape', MON.incompatible);
    // L'agent exprime mémoire et disque en GiB (1024³) ; memUsed et diskUsed sont des POURCENTAGES, formatés en chaînes « %.2f ».
    const gib = (value) => { const n = NUM_MAX(value); return n === null ? null : n * 1024 ** 3; };
    const totalDisk = gib(row.totalDisk), diskPercent = NUM_MAX(row.diskUsed, 100);
    const cpuPercent = NUM_MAX(row.cpu, 100), ramUsedBytes = gib(row.memUsedGB), ramTotalBytes = gib(row.memTotal);
    const storageUsedBytes = totalDisk !== null && diskPercent !== null ? totalDisk * diskPercent / 100 : null;
    if ([cpuPercent, ramUsedBytes, ramTotalBytes, storageUsedBytes, totalDisk].every((v) => v === null)) return off('incompatible_response', 'no_usable_field', MON.incompatible);
    const observedAt = str(row.timestamp), observed = Date.parse(observedAt);
    const known = Number.isFinite(observed), fresh = known && this.now() - observed <= METRICS_MAX_AGE_MS;
    const status = fresh ? 'available' : known ? 'stale' : 'unknown';
    return { ...emptyServer(status, status === 'available' ? null : status === 'stale' ? 'older_than_5_min' : 'timestamp_invalid', fresh ? null : known ? MON.stale : MON.stale_unknown), observedAt: known ? observedAt : null, cpuPercent, ramUsedBytes, ramTotalBytes, storageUsedBytes, storageTotalBytes: totalDisk };
  }

  /** Lecture d'un journal : renvoie toujours un état explicite (available | empty | unsupported | permission | temporary). */
  async logs(id) {
    if (typeof id !== 'string' || !ID_RE.test(id)) throw new DokployError(400, 'deployment_invalid', 'Identifiant de déploiement invalide.');
    const base = { available: false, logs: null, redacted: true, truncated: false, filtered: false };
    // DOKPLOY_LOGS_ENABLED=false : aucun journal n'est relu ni relayé (aucun appel Dokploy).
    if (this.config.logsEnabled === false) return { ...base, state: 'unsupported', message: 'Affichage des journaux désactivé sur ce dashboard (DOKPLOY_LOGS_ENABLED=false) : consultez-les dans Dokploy.' };
    const checked = checkDokployUrl(this.config.url);
    if (this.configured && !checked.url) throw new DokployError(503, 'dokploy_configuration', 'Configuration Dokploy invalide.', 'configuration');
    if (!this.configured) throw new DokployError(503, 'dokploy_configuration', 'Dokploy n’est pas configuré.', 'configuration');
    try { await this.readVersion(); } catch { /* version facultative ici */ }
    const caps = await this.capabilities();
    if (caps.deploymentLogs === 'unsupported') return { ...base, state: 'unsupported', message: caps.deploymentLogsReason };
    if (!this.knownDeployments.has(id)) await this.snapshot();
    if (!this.knownDeployments.has(id)) throw new DokployError(404, 'deployment_unknown', 'Déploiement inconnu.');
    const known = this.knownDeployments.get(id);
    const transport = caps.deploymentLogsTransport;
    if (transport === 'websocket' && normalizeVersion(this.versionCache?.value) === '0.26.5') {
      const result = await this.native.logs(known.logPath, known.serverId);
      if (result.state !== 'available') return { ...base, source: 'dokploy_native', transport, state: result.state, dokployUrl: known.dokployUrl, message: result.state === 'unsupported' ? 'Chemin de journal absent ou non sûr : consultez ce service dans Dokploy.' : result.state === 'permission' ? 'Droits insuffisants pour lire le journal natif dans Dokploy.' : 'Lecture du journal natif momentanément impossible : consultez Dokploy ou réessayez.' };
      const cleaned = this.cleanLogs(result.text);
      return { ...base, source: 'dokploy_native', transport, state: cleaned.text ? 'available' : 'empty', available: Boolean(cleaned.text), logs: cleaned.text || null, truncated: result.truncated || cleaned.truncated, filtered: cleaned.text !== result.text, dokployUrl: known.dokployUrl, message: null };
    }
    let result;
    try { result = await this.call('deployment.readLogs', { deploymentId: id, tail: LOG_LINES }); }
    catch (err) {
      if (err.reason === 'auth') return { ...base, state: 'permission', message: 'Droits insuffisants : la clé API Dokploy ne permet pas de lire les journaux de ce déploiement.' };
      if (err.httpStatus === 404 && /procedure|route|not found.*readLogs|readLogs/i.test(err.remote)) return { ...base, state: 'unsupported', message: caps.deploymentLogs === 'unknown' ? 'Cette version de Dokploy ne semble pas fournir la lecture des journaux via l’API. Consultez-les dans Dokploy.' : caps.deploymentLogsReason };
      if (err.httpStatus === 404) return { ...base, state: 'empty', message: 'Dokploy n’a trouvé aucun journal pour ce déploiement.' };
      if (err instanceof DokployError) return { ...base, state: 'temporary', message: 'Lecture des journaux momentanément impossible. Réessayez dans un instant ou consultez Dokploy.' };
      throw err;
    }
    if (result === null) return { ...base, state: 'empty', message: 'Le journal de ce déploiement est vide.' };   // 200 sans corps
    const text = typeof result === 'string' ? result : typeof result?.logs === 'string' ? result.logs : null;
    if (text === null) return { ...base, state: 'temporary', message: 'Réponse de Dokploy dans un format inattendu : journal illisible.' };
    if (!text.trim()) return { ...base, state: 'empty', message: 'Le journal de ce déploiement est vide.' };
    const { text: logs, truncated } = this.cleanLogs(text);
    const masked = /\[masqué\]|\[bloc PEM masqué\]/.test(logs) && !/\[masqué\]|\[bloc PEM masqué\]/.test(text);
    return { ...base, state: logs ? 'available' : 'empty', available: Boolean(logs), logs, truncated, filtered: masked || truncated, message: logs ? null : 'Le journal ne contient aucun texte affichable.' };
  }

  purgeOperations() {
    const now = this.now();
    for (const [key, op] of this.operations) {
      if (isActive(op) && op.startedAt + OPERATION_TTL_MS < now) this.expire(op);
      if (!isActive(op) && op.updatedAt + FINISHED_TTL_MS < now) this.operations.delete(key);
    }
    // Plafond : on évince les plus anciennes opérations terminées, jamais une opération en cours.
    for (const [key, op] of this.operations) { if (this.operations.size < OPERATIONS_MAX) break; if (!isActive(op)) this.operations.delete(key); }
  }
  expire(op) { op.status = 'unknown'; op.updatedAt = this.now(); op.message = 'Suivi expiré : vérifiez le résultat dans Dokploy.'; }

  /** Liste blanche DOKPLOY_ACTION_ALLOWLIST : ID de service, ID ou nom de projet. Vide = tous (cas inatteignable en production : l’API refuse de démarrer, voir config.assertSecrets). */
  assertActionAllowed(service) {
    const list = this.config.actionAllowlist || [];
    if (!list.length) return;
    const keys = [service.id, service.projectId, service.projectName].filter(Boolean);
    if (!keys.some((k) => list.includes(k))) throw new DokployError(403, 'service_not_allowed', 'Action non autorisée sur ce service (hors DOKPLOY_ACTION_ALLOWLIST).');
  }

  async redeploy(type, id, confirmed) {
    if (confirmed !== true) throw new DokployError(400, 'confirmation_required', 'Confirmation requise.');
    if (!REDEPLOY_TYPES.includes(type)) throw new DokployError(400, 'service_type_invalid', 'Type de service invalide.');
    if (typeof id !== 'string' || !ID_RE.test(id)) throw new DokployError(400, 'service_id_invalid', 'Identifiant de service invalide.');
    const snap = await this.snapshot();
    if (snap.status === 'not_configured') throw new DokployError(503, 'dokploy_configuration', 'Dokploy n’est pas configuré.', 'configuration');
    if (snap.status === 'error') throw new DokployError(503, snap.reason === 'auth' ? 'dokploy_auth' : 'dokploy_unavailable', snap.notes[0], snap.reason);
    const service = snap.services.find((s) => s.id === id && s.type === type);
    if (!service?.canRedeploy) throw new DokployError(409, 'redeploy_unavailable', 'Redéploiement indisponible.');
    this.assertActionAllowed(service);
    const before = new Set((await this.deploymentRows(type, id)).map((row) => row.deploymentId));
    // Aucune attente entre la vérification et l'enregistrement : deux demandes simultanées ne passent pas ensemble.
    this.purgeOperations();
    for (const operation of this.operations.values()) if (operation.serviceId === id && isActive(operation)) throw new DokployError(409, 'redeploy_running', 'Un redéploiement est déjà en cours.');
    const operationId = randomUUID(), marker = `Dashboard ${operationId}`;
    const info = { id, name: service.name, type, projectId: service.projectId, projectName: service.projectName, environmentId: service.environmentId, environmentName: service.environmentName, context: service.context };
    const operation = { operationId, type, serviceId: id, serviceName: service.name, service: info, status: 'pending', startedAt: this.now(), updatedAt: this.now(), before, marker, deployment: null, message: 'Redéploiement demandé.' };
    this.operations.set(operationId, operation);
    try { await this.call(`${type}.redeploy`, { [`${type}Id`]: id, title: marker, description: 'Redéploiement confirmé depuis le dashboard.' }, 'POST'); }
    catch (err) { this.operations.delete(operationId); throw err; }
    this.cache = null;
    return { operationId, status: operation.status, ...this.operationInfo(operation) };
  }

  // Rechargement d'une application (application.reload) : ré-applique la configuration et force la mise à jour du service, sans reconstruction.
  // Aucune ligne de déploiement n'est créée : le suivi repose sur la réponse HTTP puis la relecture du statut du service.
  async reload(id, confirmed) {
    if (confirmed !== true) throw new DokployError(400, 'confirmation_required', 'Confirmation requise.');
    if (typeof id !== 'string' || !ID_RE.test(id)) throw new DokployError(400, 'service_id_invalid', 'Identifiant de service invalide.');
    const snap = await this.snapshot();
    if (snap.status === 'not_configured') throw new DokployError(503, 'dokploy_configuration', 'Dokploy n’est pas configuré.', 'configuration');
    if (snap.status === 'error') throw new DokployError(503, snap.reason === 'auth' ? 'dokploy_auth' : 'dokploy_unavailable', snap.notes[0], snap.reason);
    const service = snap.services.find((s) => s.id === id);
    if (!service) throw new DokployError(404, 'service_unknown', 'Service inconnu.');
    this.assertActionAllowed(service);
    if (service.type !== 'application') throw new DokployError(409, 'reload_unsupported_type', service.type === 'compose' ? 'Le rechargement n’est pas disponible pour les services Compose dans Dokploy.' : 'Le rechargement n’est disponible que pour les applications.');
    if (snap.capabilities?.reload === 'unsupported') throw new DokployError(409, 'reload_unavailable', snap.capabilities.reloadReason || 'Rechargement indisponible sur cette version de Dokploy.');
    const appName = service.appName;
    if (!service.canReload || typeof appName !== 'string' || !APPNAME_RE.test(appName)) throw new DokployError(409, 'reload_unavailable', 'Rechargement indisponible : identifiant technique du service absent ou invalide.');
    // Vérification et enregistrement sans attente intermédiaire : une seule action à la fois par service (partagée avec redeploy).
    this.purgeOperations();
    for (const operation of this.operations.values()) if (operation.serviceId === id && isActive(operation)) throw new DokployError(409, 'action_running', 'Une action est déjà en cours sur ce service.');
    const operationId = randomUUID();
    const info = { id, name: service.name, type: 'application', projectId: service.projectId, projectName: service.projectName, environmentId: service.environmentId, environmentName: service.environmentName, context: service.context };
    const operation = { operationId, kind: 'reload', type: 'application', serviceId: id, serviceName: service.name, service: info, status: 'running', startedAt: this.now(), updatedAt: this.now(), deployment: null, message: 'Rechargement en cours…' };
    this.operations.set(operationId, operation);
    this.runReload(operation, appName).catch(() => { this.finishReload(operation, 'error', 'Échec du rechargement.'); });
    return { operationId, status: operation.status, ...this.operationInfo(operation) };
  }
  finishReload(op, status, message) { if (!isActive(op)) return; op.status = status; op.message = message; op.updatedAt = this.now(); this.cache = null; }
  async runReload(op, appName) {
    let result;
    try { result = await this.call('application.reload', { applicationId: op.serviceId, appName }, 'POST', { timeoutMs: RELOAD_TIMEOUT_MS }); }
    catch (err) {
      if (err.reason === 'auth') return this.finishReload(op, 'error', 'Échec du rechargement : droits insuffisants pour cette action (clé API ou permission de déploiement).');
      if (err.reason === 'network') return this.finishReload(op, 'error', 'Échec du rechargement : Dokploy est indisponible. Vérifiez l’état du service dans Dokploy.');
      return this.finishReload(op, 'error', 'Échec du rechargement.');
    }
    if (result === false) return this.finishReload(op, 'error', 'Échec du rechargement.');
    op.message = 'Rechargement accepté, vérification du statut du service…'; op.updatedAt = this.now(); this.cache = null;
    // Relecture du statut (allowlistée) : « done » = mise à jour acceptée, jamais une preuve que le conteneur est sain.
    for (let i = 0; i < RELOAD_POLL_TRIES && isActive(op); i++) {
      if (i) await this.sleep(RELOAD_POLL_MS);
      let status = null;
      try { status = (await this.snapshot(true)).services?.find((s) => s.id === op.serviceId)?.status ?? null; } catch { status = null; }   // coupure brève possible : erreur transitoire tolérée
      if (status === 'done') return this.finishReload(op, 'done', 'Rechargement terminé : Dokploy indique un statut « terminé ». Cela ne garantit pas la bonne santé du service.');
      if (status === 'error') return this.finishReload(op, 'error', 'Échec du rechargement : Dokploy indique un statut en erreur.');
    }
    this.finishReload(op, 'unknown', 'Rechargement accepté, mais le statut final n’a pas pu être confirmé : vérifiez le service dans Dokploy.');
  }
  operationInfo(op) { return { serviceId: op.serviceId, serviceName: op.service?.name ?? op.serviceName ?? null, serviceType: op.type, projectName: op.service?.projectName ?? null, environmentName: op.service?.environmentName ?? null, context: op.service?.context ?? null }; }

  async operation(id) {
    const op = typeof id === 'string' ? this.operations.get(id) : null;
    if (!op) throw new DokployError(404, 'operation_unknown', 'Suivi inconnu ou serveur redémarré.');
    if (isActive(op)) {
      if (op.startedAt + OPERATION_TTL_MS < this.now()) this.expire(op);
      else if (op.kind === 'reload') { /* mis à jour par la tâche de fond : aucune lecture de déploiement */ }
      else {
        // Lecture ciblée du seul service suivi, sans snapshot complet.
        try {
          const rows = (await this.deploymentRows(op.type, op.serviceId)).filter((row) => row.title === op.marker && !op.before.has(row.deploymentId));
          if (rows.length === 1) {
            op.deployment = this.deployment(rows[0], op.service || { id: op.serviceId, name: op.serviceName, type: op.type });
            op.status = op.deployment.status === 'Indisponible' ? 'running' : op.deployment.status;
            op.message = ({ done: 'Déploiement réussi.', error: 'Déploiement échoué.', cancelled: 'Déploiement annulé.' })[op.status] || 'Déploiement en cours.';
            op.updatedAt = this.now();
            if (!isActive(op)) this.cache = null;
          } else if (rows.length > 1) { op.status = 'unknown'; op.updatedAt = this.now(); op.message = 'Plusieurs déploiements concurrents : vérifiez le résultat dans Dokploy.'; }
        } catch (err) { return { operationId: id, ...this.operationInfo(op), status: op.status, deployment: op.deployment, message: err instanceof DokployError ? `Suivi momentanément indisponible : ${err.message}` : 'Suivi momentanément indisponible.' }; }
      }
    }
    return { operationId: id, ...this.operationInfo(op), status: op.status, deployment: op.deployment, message: op.message };
  }
}
