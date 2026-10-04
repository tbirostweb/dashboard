// Orchestration : tokens (refresh), appels aux connecteurs (avec cache TTL), composition du dataset,
// repli sur les données de démo (MOCK_FALLBACK) pour les plateformes non connectées.
import { PLATFORMS, LABELS } from './providers/index.js';
import { platformConfigured, LINKEDIN_COMMENTS_RETENTION_HOURS } from './config.js';
import { ProviderError } from './http.js';
import { buildDaily, emptyDaily, lastDates } from './aggregate.js';
import { isoDay } from './util.js';
import { PENDING_MESSAGE } from './providers/linkedin.js';
import { CallMeter, slowdownFactor } from './meter.js';
import { mergeLight, applyHeavy } from './merge.js';
import { scrub } from './cachefile.js';
import { tokenStatus, retryDelayMs, RENEW_ERROR_MESSAGES, reconnectPathOf } from './tokens.js';

const DAY_MS = 86_400_000;
const MAX_STALE_MS = 7 * DAY_MS;            // au-delà, une donnée périmée n'est plus servie : on attend la relecture
const ERROR_TTL_MS = 60_000;                 // cache négatif d'une plateforme en erreur
const ERROR_TTL_MAX_MS = 15 * 60_000;        // backoff exponentiel plafonné (429)
const RESTORED_PARTIAL_GAP_MS = 3_600_000;   // LinkedIn restauré du disque : au plus une relecture automatique par heure
const PERSIST_DELAY_MS = 3000;
const MAX_PERSISTED_POSTS = 400;
// Blocs encore en cours de chargement tant que le palier lourd n'a pas complété le jeu de données.
export const INSIGHT_LOADING_BLOCKS = ['account_insights', 'audience'];
export const LOADING_BLOCKS = { instagram: ['post_insights', 'comments', 'audience'], tiktok: ['video_history', 'thumbnails'] };

/** Étapes restantes affichées tant que LinkedIn est « en attente d'approbation » (aucun secret). */
export function linkedinPendingSteps(cfg) {
  const c = cfg.linkedin;
  const steps = [
    "Attendre l'approbation du produit « Community Management API » (Development Tier) sur l'app LinkedIn.",
    "Onglet Auth de l'app : vérifier que les scopes r_organization_social et rw_organization_admin apparaissent, puis ajouter la redirect URL " + c.redirectUri,
    'Dokploy > Environment : LINKEDIN_COMMUNITY_API=true, puis redéployer.',
    'Cliquer « Connecter LinkedIn » avec un compte super administrateur de la Page ' + (c.organizationId || '(LINKEDIN_ORGANIZATION_ID manquant)') + '.'
  ];
  if (!c.clientId || !c.clientSecret) steps.splice(1, 0, 'Renseigner LINKEDIN_CLIENT_ID et LINKEDIN_CLIENT_SECRET dans Dokploy (onglet Auth de l\'app).');
  return steps;
}

/** Échec d'un renouvellement de jeton : code 'not_connected' | 'pending_approval' | 'not_refreshable' | 'reconnect_required' | 'too_soon' | 'upstream'. */
export class RenewError extends Error {
  constructor(code, message, extra = {}) { super(message); this.name = 'RenewError'; this.code = code; this.extra = extra; }
}

export class DataService {
  constructor({ cfg, store, providers, cache, mock, logger, now = () => Date.now(), meter, cacheFile = null, presence = null }) {
    Object.assign(this, { cfg, store, providers, cache, mock, logger, now, cacheFile, presence });
    this.meter = meter || new CallMeter({ now });
    this.lastResult = {}; // plateforme -> { status, at, message, notes, account }
    this.fetchedAt = {}; // plateforme -> ISO de la dernière récupération réelle réussie (jamais l'heure d'une lecture du cache)
    this.lastManualRenew = {}; // plateforme -> ms du dernier renouvellement manuel de jeton
    this.renewing = {};     // plateforme -> promesse du renouvellement en cours (single-flight : TikTok fait tourner le refresh token)
    this.lastManualRefresh = {}; // plateforme -> ms de la dernière actualisation manuelle
    this.slots = {};        // plateforme -> { raw, lightAt, heavyAt, restored } : dernier jeu valide, conservé au-delà du TTL (SWR)
    this.inflight = {};     // plateforme -> { light?, heavy? } : un cycle de lecture par palier et par plateforme (single-flight par palier)
    this.epoch = {};        // plateforme -> compteur incrémenté à la déconnexion (rejette les lectures tardives)
    this.errStreak = {};    // plateforme -> nombre d'erreurs consécutives (backoff)
    this.refreshErrors = {};// plateforme -> { code, message, at } dernière erreur de revalidation
    this.insightSlots = {}; // plateforme -> { [période]: { body, at } }
    this.insightInflight = new Map();
    this.insightRequested = {}; // plateforme -> { [période]: ms de la dernière demande }
    this.background = new Set();
    this.dirty = false;
    this.persistTimer = null;
  }

  /** Suit une promesse d'arrière-plan (jamais de rejet non géré) ; settle() les attend (tests, arrêt propre). */
  track(promise) {
    const p = Promise.resolve(promise).catch(() => {}).finally(() => this.background.delete(p));
    this.background.add(p);
    return p;
  }

  async settle() {
    while (this.background.size) await Promise.all([...this.background]);
  }

  hasTier(platform) { return typeof this.providers[platform].fetchLight === 'function'; }
  isRefreshing(platform) { return Boolean(this.inflight[platform]); }

  /** TTL du cache d'une plateforme. LinkedIn : cache dédié (budget d'appels) plafonné à 48 h (commentaires de membres). */
  ttlMs(platform) {
    if (platform === 'linkedin') {
      return Math.min(this.cfg.linkedin.cacheTtlSeconds, LINKEDIN_COMMENTS_RETENTION_HOURS * 3600) * 1000;
    }
    return this.cfg.cacheTtlSeconds * 1000;
  }

  /** TTL effectif exposé à l'API (secondes). */
  cacheTtlSeconds(platform) { return Math.round(this.ttlMs(platform) / 1000); }

  /** Oublie tout ce qui concerne une plateforme (connexion/déconnexion). */
  forget(platform) {
    this.invalidate(platform);
    delete this.lastResult[platform];
    delete this.fetchedAt[platform];
    delete this.slots[platform];
    delete this.insightSlots[platform];
    delete this.insightRequested[platform];
    delete this.refreshErrors[platform];
    delete this.errStreak[platform];
    this.epoch[platform] = (this.epoch[platform] || 0) + 1; // une lecture en vol ne ressuscite pas un compte déconnecté
    this.markDirty();
  }

  // ------------------------------------------------------------ Tokens
  /** Renvoie un token valide (rafraîchi si nécessaire) ou null. Lève ProviderError('auth') si expiré. */
  async freshToken(platform) {
    let token = await this.store.getToken(platform);
    if (!token) return null;
    const provider = this.providers[platform];
    if (provider.needsRefresh(token) && !(await this.renewBackoffActive(platform))) {
      try {
        const r = await this.renewToken(platform);
        if (r && r.token) token = r.token;
      } catch (err) {
        // Jamais de message brut du fournisseur dans les journaux : code seulement
        this.logger.warn({ platform, code: err.code }, 'échec du renouvellement automatique du jeton');
        if (token.expiresAt <= this.now()) throw new ProviderError(platform, 'auth', 'Token expiré et rafraîchissement impossible : reconnectez le compte.');
      }
    }
    if (token.expiresAt <= this.now()) throw new ProviderError(platform, 'auth', 'Token expiré : reconnectez le compte.');
    return token;
  }

  /** Une tentative automatique est-elle encore interdite (backoff après échec, plancher de 15 min) ? */
  async renewBackoffActive(platform) {
    const meta = await this.store.getTokenMeta(platform);
    return Boolean(meta && Number.isFinite(meta.nextRetryAt) && meta.nextRetryAt > this.now());
  }

  /** Instant (ms) à partir duquel un jeton Instagram peut être rafraîchi (24 h d'âge), null si sans contrainte. */
  renewEligibleAt(platform, token) {
    if (platform === 'instagram' && Number.isFinite(token.obtainedAt) && token.obtainedAt > 0) return token.obtainedAt + DAY_MS;
    return null;
  }

  /** Classe un échec du fournisseur : 'too_soon' | 'reconnect_required' | 'transient'. */
  classifyRenewFailure(platform, err) {
    if (!(err instanceof ProviderError)) return 'transient';
    const text = String(err.message || '').toLowerCase();
    if (platform === 'instagram' && err.status === 400 && /24 hours|at least|too (soon|early)/.test(text)) return 'too_soon';
    if (err.code === 'auth' || err.status === 400 || err.status === 401) return 'reconnect_required'; // invalid_grant, jeton expiré ou révoqué
    return 'transient'; // réseau, 429, 5xx, permission : on ne demande jamais une reconnexion pour cela
  }

  /**
   * Renouvelle le jeton d'une plateforme (single-flight). Persiste l'objet COMPLET renvoyé par le fournisseur
   * (TikTok fait tourner le refresh token), mémorise lastRenewedAt / lastRenewError (non sensibles).
   * Renvoie { token, renewedAt } ; null si rien à faire (aucun refresh possible, en mode automatique).
   * Lève RenewError.
   */
  renewToken(platform, { manual = false } = {}) {
    if (this.renewing[platform]) return this.renewing[platform];
    const p = this.#renew(platform, manual).finally(() => { delete this.renewing[platform]; });
    this.renewing[platform] = p;
    return p;
  }

  async #renew(platform, manual) {
    const provider = this.providers[platform];
    if (provider.pendingApproval) throw new RenewError('pending_approval', "En attente d'approbation LinkedIn.");
    const token = await this.store.getToken(platform);
    if (!token) throw new RenewError('not_connected', `${LABELS[platform]} n'est pas connecté.`);
    const label = LABELS[platform];
    const reconnect = { reconnectPath: reconnectPathOf(platform) };
    const t = this.now();
    const notRefreshable = () => new RenewError('not_refreshable', 'Ce réseau ne permet pas le renouvellement automatique : reconnectez le compte.', reconnect);
    const refusal = () => new RenewError('reconnect_required', `${label} refuse le renouvellement du jeton (expiré ou révoqué) : reconnectez le compte.`, reconnect);

    if (platform !== 'instagram' && !token.refreshToken) { if (manual) throw notRefreshable(); return null; }
    if (token.refreshExpiresAt && token.refreshExpiresAt <= t) { await this.recordRenewFailure(platform, 'permanent'); throw refusal(); }
    if (platform === 'instagram' && token.expiresAt <= t) { await this.recordRenewFailure(platform, 'permanent'); throw refusal(); }
    const eligibleAt = this.renewEligibleAt(platform, token);
    if (eligibleAt && eligibleAt > t) {
      throw new RenewError('too_soon', `Le jeton ${label} ne peut être renouvelé qu'après 24 h d'âge.`, { eligibleAt: new Date(eligibleAt).toISOString(), retryAfter: Math.ceil((eligibleAt - t) / 1000) });
    }

    let next;
    try {
      next = await provider.refresh(token);
    } catch (err) {
      const kind = this.classifyRenewFailure(platform, err);
      if (kind === 'too_soon') {
        const at = Number.isFinite(token.obtainedAt) && token.obtainedAt > 0 ? token.obtainedAt + DAY_MS : null;
        throw new RenewError('too_soon', `Le jeton ${label} ne peut pas encore être renouvelé (24 h d'âge minimum).`, at ? { eligibleAt: new Date(at).toISOString(), retryAfter: Math.max(1, Math.ceil((at - t) / 1000)) } : {});
      }
      await this.recordRenewFailure(platform, kind === 'reconnect_required' ? 'permanent' : 'transient');
      if (kind === 'reconnect_required') throw refusal();
      throw new RenewError('upstream', `${label} est momentanément injoignable : le renouvellement du jeton sera retenté.`);
    }
    if (!next) throw notRefreshable();

    await this.store.setToken(platform, next); // objet complet : nouveau refreshToken / refreshExpiresAt conservés
    const renewedAt = new Date(this.now()).toISOString();
    await this.store.setTokenMeta(platform, { lastRenewedAt: renewedAt, lastRenewError: null, failures: 0, nextRetryAt: null });
    // Les échecs d'authentification mémorisés ne valent plus : la prochaine lecture repart avec le nouveau jeton.
    this.cache.delete(`raw:${platform}:error`);
    if (this.refreshErrors[platform] && this.refreshErrors[platform].code === 'auth') delete this.refreshErrors[platform];
    if (this.lastResult[platform] && this.lastResult[platform].status === 'expired') delete this.lastResult[platform];
    this.logger.info({ platform, manual }, 'token rafraîchi');
    return { token: await this.store.getToken(platform), renewedAt };
  }

  /** Mémorise un échec de renouvellement (message générique, sans secret) et arme le backoff (plancher 15 min). */
  async recordRenewFailure(platform, kind) {
    const prev = (await this.store.getTokenMeta(platform)) || {};
    const failures = (prev.failures || 0) + 1;
    const permanent = kind === 'permanent';
    await this.store.setTokenMeta(platform, {
      lastRenewedAt: prev.lastRenewedAt || null,
      lastRenewError: { message: permanent ? RENEW_ERROR_MESSAGES.permanent : RENEW_ERROR_MESSAGES.transient, at: new Date(this.now()).toISOString(), permanent },
      failures,
      nextRetryAt: this.now() + retryDelayMs(failures, permanent)
    });
  }

  /** Renouvelle les jetons arrivés au seuil (TikTok < 1 h, Instagram < 7 j), sans lecture de données ; respecte le backoff. */
  async renewDueTokens() {
    for (const p of PLATFORMS) {
      const provider = this.providers[p];
      if (provider.pendingApproval) continue;
      const token = await this.store.getToken(p);
      if (!token || !provider.needsRefresh(token) || (await this.renewBackoffActive(p))) continue;
      try { await this.renewToken(p); } catch (err) {
        this.logger.warn({ platform: p, code: err.code }, 'échec du renouvellement automatique du jeton');
      }
    }
  }

  // ------------------------------------------------------------ Données par plateforme (SWR, paliers)
  rawKey(platform) { return `raw:${platform}`; }

  /** Dernier jeu de données connu (frais ou périmé), sans aucun appel. */
  currentRaw(platform) { return this.cache.get(this.rawKey(platform)) ?? this.slots[platform]?.raw ?? null; }

  heavyIntervalMs(platform) {
    const l = this.cfg.live || {};
    return (platform === 'instagram' ? l.instagramHeavySeconds : platform === 'tiktok' ? l.tiktokHeavySeconds : 0) * 1000 || this.ttlMs(platform);
  }

  /** Durée du cache négatif : 60 s ; backoff exponentiel plafonné à 15 min pour les 429 consécutifs. */
  errorTtlMs(platform, err) {
    if (err && err.code === 'rate_limit') return Math.min(ERROR_TTL_MS * 2 ** Math.max(0, (this.errStreak[platform] || 1) - 1), ERROR_TTL_MAX_MS);
    return ERROR_TTL_MS;
  }

  /**
   * Lance un cycle de lecture auprès de la plateforme. Single-flight PAR PALIER : le léger et le lourd ont chacun leur
   * promesse en vol ; une demande de palier léger ne rejoint JAMAIS un palier lourd (sinon la première réponse attendrait
   * tout le lourd). Le lourd démarre après la fin du léger en cours ; sans aucune donnée (démarrage à froid) il attend
   * d'abord un léger réussi (un échec du léger l'annule : pas de quota gaspillé), sauf `direct` (actualisation manuelle).
   * Enregistre le cycle de façon synchrone : l'appelant voit immédiatement `refreshing`.
   */
  runTier(platform, tier = 'heavy', { direct = false } = {}) {
    if (tier === 'light' && !this.hasTier(platform)) tier = 'heavy';
    const slots = (this.inflight[platform] ||= {});
    if (slots[tier]) return slots[tier].promise;
    let wait = null;
    if (tier === 'heavy' && this.hasTier(platform)) {
      const cold = !this.slots[platform]?.raw;
      if (slots.light) wait = cold && !direct ? slots.light.promise : slots.light.promise.catch(() => {});
      else if (cold && !direct) wait = this.runTier(platform, 'light');
    }
    const entry = {};
    const run = wait ? wait.then(() => this.executeTier(platform, tier)) : this.executeTier(platform, tier);
    entry.promise = run.finally(() => {
      if (slots[tier] === entry) delete slots[tier];
      if (!slots.light && !slots.heavy && this.inflight[platform] === slots) delete this.inflight[platform];
    });
    entry.promise.catch(() => {});
    slots[tier] = entry;
    return entry.promise;
  }

  async executeTier(platform, tier) {
    const epoch = this.epoch[platform] || 0;
    const provider = this.providers[platform];
    try {
      const token = await this.freshToken(platform);
      if (!token) throw new ProviderError(platform, 'auth', 'Compte déconnecté.');
      let result;
      if (tier === 'light') result = await provider.fetchLight(token, { previous: this.slots[platform]?.raw || null });
      else result = await provider.fetchData(token);
      if ((this.epoch[platform] || 0) !== epoch) return null; // déconnecté pendant la lecture : résultat jeté
      // Les deux paliers peuvent se chevaucher : on fusionne avec le jeu COURANT (relu après l'attente), jamais celui du départ.
      const slot = this.slots[platform];
      const raw = tier === 'light'
        ? mergeLight(slot?.raw || null, result, { heavyKeys: provider.heavyPostKeys || [] })
        : applyHeavy(slot?.raw || null, result);
      const t = this.now();
      if (Number.isFinite(raw.followers)) await this.store.recordSnapshot(platform, isoDay(t), raw.followers);
      const next = { raw, lightAt: t, heavyAt: tier === 'heavy' ? t : (this.slots[platform]?.heavyAt ?? slot?.heavyAt ?? null), restored: false };
      this.slots[platform] = next;
      this.cache.set(this.rawKey(platform), raw, this.ttlMs(platform));
      this.fetchedAt[platform] = new Date(t).toISOString();
      this.cache.delete(`raw:${platform}:error`);
      delete this.refreshErrors[platform];
      this.errStreak[platform] = 0;
      this.markDirty();
      return raw;
    } catch (err) {
      if (err instanceof ProviderError && (this.epoch[platform] || 0) === epoch) {
        this.errStreak[platform] = (this.errStreak[platform] || 0) + 1;
        this.cache.set(`raw:${platform}:error`, err, this.errorTtlMs(platform, err));
        this.refreshErrors[platform] = { code: err.code, message: err.message, at: new Date(this.now()).toISOString() };
      }
      throw err;
    }
  }

  /** Revalidation en arrière-plan (jamais attendue par une requête) : léger d'abord, puis lourd s'il est échu. */
  revalidate(platform) {
    if (this.cache.get(`raw:${platform}:error`)) return;
    const slot = this.slots[platform];
    const heavyDue = !slot || slot.heavyAt === null || this.now() - slot.heavyAt >= this.heavyIntervalMs(platform) || Boolean(slot.raw?.partial);
    if (this.hasTier(platform)) {
      this.track(this.runTier(platform, 'light'));
      if (heavyDue) this.track(this.runTier(platform, 'heavy'));
    } else {
      this.track(this.runTier(platform, 'heavy'));
    }
  }

  /**
   * Lit le jeu de données d'une plateforme SANS attendre le fournisseur si une donnée existe (même périmée).
   * Renvoie { raw, stale, loading }. Sans aucune donnée : palier léger attendu (réponse partielle rapide), lourd en fond ;
   * plateforme sans palier léger (LinkedIn) : lecture complète attendue comme avant.
   */
  async readPlatform(platform) {
    const errKey = `raw:${platform}:error`;
    const recent = this.cache.get(errKey);
    const fresh = this.cache.get(this.rawKey(platform));
    if (fresh) return { raw: fresh, stale: false };
    const slot = this.slots[platform];
    if (slot && slot.raw) {
      const age = this.now() - (slot.lightAt ?? 0);
      if (recent && recent.code === 'auth') throw recent;
      const tooStale = platform === 'linkedin' ? age > LINKEDIN_COMMENTS_RETENTION_HOURS * 3_600_000 : age > MAX_STALE_MS;
      if (tooStale) { // jamais de donnée de membres LinkedIn de plus de 48 h ; autres plateformes : plafond de 7 jours
        if (recent) throw recent;
        await this.runTier(platform, 'heavy');
        return { raw: this.slots[platform].raw, stale: false };
      }
      const hold = platform === 'linkedin' && slot.restored && age < RESTORED_PARTIAL_GAP_MS;
      if (!recent && !hold) this.revalidate(platform);
      return { raw: slot.raw, stale: true };
    }
    if (recent) throw recent;
    if (this.hasTier(platform)) {
      await this.runTier(platform, 'light');
      this.track(this.runTier(platform, 'heavy'));
      return { raw: this.slots[platform].raw, stale: false };
    }
    await this.runTier(platform, 'heavy');
    return { raw: this.slots[platform].raw, stale: false };
  }

  /** Données brutes d'une plateforme ; `force` : relecture complète attendue (actualisation manuelle, maintenance). */
  async platformRaw(platform, { force = false } = {}) {
    if (force) {
      this.cache.delete(`raw:${platform}:error`);
      await this.runTier(platform, 'heavy', { direct: true });
      return this.slots[platform]?.raw ?? null;
    }
    return (await this.readPlatform(platform)).raw;
  }

  loadingBlocks(platform) {
    const slot = this.slots[platform];
    if (!slot || !slot.raw || !slot.raw.partial || !LOADING_BLOCKS[platform]) return [];
    return this.cache.get(`raw:${platform}:error`) ? [] : [...LOADING_BLOCKS[platform]];
  }

  /** Métadonnées de fraîcheur d'une plateforme connectée. */
  freshness(platform) {
    const slot = this.slots[platform];
    const at = this.fetchedAt[platform] || null;
    const stale = Boolean(slot && slot.raw && this.now() - (slot.lightAt ?? 0) > this.ttlMs(platform));
    return {
      updatedAt: at,
      heavyUpdatedAt: slot && slot.heavyAt ? new Date(slot.heavyAt).toISOString() : null,
      stale,
      refreshing: this.isRefreshing(platform),
      loading: this.loadingBlocks(platform),
      refreshError: this.refreshErrors[platform] ? { code: this.refreshErrors[platform].code, message: this.refreshErrors[platform].message, at: this.refreshErrors[platform].at } : null
    };
  }

  /** Charge une plateforme et renvoie { status, account, daily, posts, comments, notes, message }. */
  async loadPlatform(platform, dates) {
    const label = LABELS[platform];
    const placeholder = { platform, name: label, handle: '', url: '' };
    const pending = (message = PENDING_MESSAGE) => {
      this.lastResult[platform] = { status: 'pending_approval', at: new Date(this.now()).toISOString(), message, notes: [] };
      // Jamais de données fictives dans cet état, même avec MOCK_FALLBACK=true
      return { status: 'pending_approval', message, account: placeholder, daily: emptyDaily(dates), posts: [], comments: null, notes: [] };
    };
    if (this.providers[platform].pendingApproval) return pending();
    const token = await this.store.getToken(platform);

    if (token) {
      try {
        const { raw } = await this.readPlatform(platform);
        if (!raw) throw new ProviderError(platform, 'auth', 'Compte déconnecté.');
        const snapshots = await this.store.getSnapshots(platform);
        const fetchedAt = this.fetchedAt[platform] || null;
        // Garde-fou de conformité : au-delà de la rétention, les commentaires LinkedIn ne sont plus servis
        let comments = raw.comments;
        if (platform === 'linkedin' && Array.isArray(comments)) {
          const maxAge = (raw.commentsRetentionHours || LINKEDIN_COMMENTS_RETENTION_HOURS) * 3_600_000;
          if (!fetchedAt || this.now() - Date.parse(fetchedAt) > maxAge) comments = [];
        }
        const result = {
          status: raw.limited ? 'limited' : 'connected',
          account: raw.account,
          daily: buildDaily(raw, snapshots, dates),
          posts: raw.posts,
          comments, // null = non disponible (TikTok, LinkedIn sans Community Management)
          notes: raw.notes || [],
          details: raw.details || null,
          fetchedAt,
          meta: this.freshness(platform)
        };
        this.lastResult[platform] = { status: result.status, at: fetchedAt, notes: result.notes, account: raw.account };
        return result;
      } catch (err) {
        if (!(err instanceof ProviderError)) throw err;
        if (err.code === 'pending_approval') return pending(err.message);
        const status = err.code === 'auth' ? 'expired' : 'error';
        this.logger.warn({ platform, code: err.code }, `échec de la récupération : ${err.message}`);
        this.lastResult[platform] = { status, at: new Date(this.now()).toISOString(), message: err.message, notes: [], account: (this.lastResult[platform] || {}).account };
        return { status, message: err.message, account: placeholder, daily: emptyDaily(dates), posts: [], comments: [], notes: [] };
      }
    }

    return { status: 'not_connected', account: placeholder, daily: emptyDaily(dates), posts: [], comments: [], notes: [] };
  }

  /** Dataset complet, au format de data/mock.js, + statut par plateforme. */
  async dataset() {
    const dates = lastDates(undefined, this.now());
    const results = await Promise.all(PLATFORMS.map((p) => this.loadPlatform(p, dates)));
    const d = { accounts: {}, daily: {}, posts: [], comments: [], platforms: {}, details: {} };
    PLATFORMS.forEach((p, i) => {
      const r = results[i];
      d.accounts[p] = r.account;
      d.daily[p] = r.daily;
      d.details[p] = r.details || null;
      d.posts.push(...r.posts);
      if (Array.isArray(r.comments)) d.comments.push(...r.comments);
      d.platforms[p] = {
        status: r.status,
        commentsAvailable: Array.isArray(r.comments) || r.status === 'not_connected',
        ...(r.status === 'pending_approval' ? { pendingSteps: linkedinPendingSteps(this.cfg) } : {}),
        message: r.message || null,
        notes: r.notes,
        updatedAt: r.fetchedAt || null,
        ...(r.meta ? { heavyUpdatedAt: r.meta.heavyUpdatedAt, stale: r.meta.stale, refreshing: r.meta.refreshing, loading: r.meta.loading, ...(r.meta.refreshError ? { refreshError: r.meta.refreshError } : {}) } : {})
      };
    });
    return d;
  }

  // ------------------------------------------------------------ Insights de compte (Instagram)
  supportsInsights(platform) {
    return Boolean(this.providers[platform] && typeof this.providers[platform].fetchInsights === 'function');
  }

  /**
   * Insights normalisés pour la période (7/30/90 j) + période précédente.
   * `d` = dataset déjà chargé (statut de la plateforme + série journalière pour les mini-graphiques).
   * Mis en cache avec le même TTL que les données brutes ; préfixe raw:<plateforme> pour être vidé à la déconnexion.
   */
  async insights(platform, period, d) {
    const cur = d.daily[platform].slice(-period);
    const series = { dates: cur.map((x) => x.date), reach: cur.map((x) => x.views), newFollowers: cur.map((x) => x.newFollowers) };
    const key = this.insightKey(platform, period);
    (this.insightRequested[platform] ||= {})[period] = this.now();
    const entry = this.insightSlots[platform]?.[period];
    let stale = false;
    let body;
    let at;
    if (this.cache.get(key) !== undefined && entry) {
      body = entry.body; at = entry.at;
    } else if (entry) { // périmé : réponse immédiate, relecture en arrière-plan
      body = entry.body; at = entry.at; stale = true;
      this.track(this.loadInsights(platform, period).catch((err) => this.logger.warn({ platform, code: err.code }, `insights : revalidation en échec : ${err.message}`)));
    } else if (this.hasTier(platform) && this.slots[platform] && this.slots[platform].heavyAt === null && !this.cache.get(`${key}:error`)) {
      // Démarrage à froid : le palier lourd n'a pas fini. Aucune attente du fournisseur : état `loading` immédiat
      // (le palier lourd lit ensuite les insights connus ; la requête suivante les trouve en cache).
      return { platform, period, generatedAt: null, views: null, interactions: null, profile: null, audience: null, errors: {}, notes: [], series, updatedAt: null, stale: false, refreshing: true, loading: [...INSIGHT_LOADING_BLOCKS] };
    } else { // aucun cache : on attend la lecture (palier lourd par nature)
      body = await this.loadInsights(platform, period);
      at = this.insightSlots[platform][period].at;
    }
    return { platform, period, ...body, series, updatedAt: new Date(at).toISOString(), stale, refreshing: this.insightInflight.has(key) };
  }

  insightKey(platform, period) { return `raw:${platform}:insights:${period}`; }

  /** Lecture des insights d'une période (single-flight par plateforme et période). */
  loadInsights(platform, period) {
    const key = this.insightKey(platform, period);
    if (this.insightInflight.has(key)) return this.insightInflight.get(key);
    const epoch = this.epoch[platform] || 0;
    const p = (async () => {
      if (this.cache.get(`${key}:error`)) throw this.cache.get(`${key}:error`);
      try {
        const token = await this.freshToken(platform);
        if (!token) throw new ProviderError(platform, 'auth', 'Compte déconnecté.');
        const body = await this.providers[platform].fetchInsights(token, { period });
        if ((this.epoch[platform] || 0) !== epoch) return body;
        const at = this.now();
        (this.insightSlots[platform] ||= {})[period] = { body, at };
        this.cache.set(key, true, this.cfg.cacheTtlSeconds * 1000);
        this.markDirty();
        return body;
      } catch (err) {
        if (err instanceof ProviderError) this.cache.set(`${key}:error`, err, ERROR_TTL_MS);
        throw err;
      }
    })().finally(() => this.insightInflight.delete(key));
    this.insightInflight.set(key, p);
    return p;
  }

  /** Palier lourd Instagram : relit les insights des périodes demandées récemment (+ 30 j par défaut), en parallèle. */
  async refreshInsightsKnown(platform) {
    if (!this.supportsInsights(platform)) return;
    const recent = Object.entries(this.insightRequested[platform] || {}).filter(([, t]) => this.now() - t < DAY_MS).map(([p]) => Number(p));
    const periods = [...new Set([30, ...recent])].slice(0, 3);
    await Promise.all(periods.map((period) => this.loadInsights(platform, period).catch((err) => {
      this.logger.warn({ platform, code: err.code }, `insights : relecture en échec : ${err.message}`);
    })));
  }

  // ------------------------------------------------------------ Statut (sans appel aux plateformes)
  async status() {
    const out = {};
    for (const p of PLATFORMS) {
      const token = await this.store.getToken(p);
      const last = this.lastResult[p] || {};
      const configured = platformConfigured(this.cfg, p);
      let status;
      const pending = this.providers[p].pendingApproval || last.status === 'pending_approval';
      if (pending) status = 'pending_approval';
      else if (token) status = token.expiresAt <= this.now() && !token.refreshToken ? 'expired' : (last.status || 'connected');
      else status = 'not_connected';
      const meta = token ? await this.store.getTokenMeta(p) : null;
      out[p] = {
        label: LABELS[p],
        configured,
        connected: Boolean(token),
        status,
        account: token && last.account ? { name: last.account.name, handle: last.account.handle } : null,
        expiresAt: token ? new Date(token.expiresAt).toISOString() : null,
        refreshable: Boolean(token && (token.refreshToken || p === 'instagram')),
        refreshExpiresAt: token && token.refreshExpiresAt ? new Date(token.refreshExpiresAt).toISOString() : null,
        connectedAt: token ? token.updatedAt || null : null,
        lastFetchAt: this.fetchedAt[p] || null,
        updatedAt: this.fetchedAt[p] || null,
        heavyUpdatedAt: this.slots[p] && this.slots[p].heavyAt ? new Date(this.slots[p].heavyAt).toISOString() : null,
        stale: Boolean(token) && this.freshness(p).stale,
        refreshing: this.isRefreshing(p),
        loading: this.loadingBlocks(p),
        callsLastHour: this.meter.callsLastHour(p),
        quota: this.quotaOf(p),
        message: last.message || null,
        notes: last.notes || [],
        commentsAvailable: this.providers[p].capabilities.comments,
        cacheTtlSeconds: this.cacheTtlSeconds(p),
        token: tokenStatus({ platform: p, token, meta, now: this.now(), pending: Boolean(pending) }),
        ...(p === 'linkedin' ? { budget: (() => { const b = this.linkedinBudget(); return b ? { used: b.used, limit: b.limit, resetsAt: b.resetsAt } : null; })() } : {}),
        ...(pending ? { pendingSteps: linkedinPendingSteps(this.cfg), message: last.message || PENDING_MESSAGE } : {})
      };
    }
    return out;
  }

  /** État du quota fournisseur (sans secret) : ce qui est connu, jamais deviné. */
  quotaOf(platform) {
    if (platform === 'instagram') {
      const percent = this.meter.usagePercent('instagram');
      return { kind: 'meta_app_usage', usagePercent: percent, slowdownFactor: slowdownFactor(percent), note: 'Quota Meta : 4800 x impressions du compte / 24 h ; les en-têtes X-App-Usage sont surveillés quand Meta les renvoie.' };
    }
    if (platform === 'tiktok') return { kind: 'requests_per_minute', limitPerMinute: 600, callsLastMinute: this.meter.callsLastMinute('tiktok') };
    const b = this.linkedinBudget();
    return { kind: 'daily_budget', used: b ? b.used : null, limit: b ? b.limit : this.cfg.linkedin.dailyCallBudget, resetsAt: b ? b.resetsAt : null, platformLimitPerDay: 100 };
  }

  /** Budget LinkedIn connu (dernier relevé en cache) : { used, limit, resetsAt, exhausted } ou null. */
  linkedinBudget() {
    const b = this.currentRaw('linkedin')?.details?.budget;
    if (!b || !Number.isFinite(b.used) || !Number.isFinite(b.limit)) return null;
    const active = Date.parse(b.resetsAt) > this.now();
    return { used: b.used, limit: b.limit, resetsAt: b.resetsAt, exhausted: active && b.used >= b.limit };
  }

  /**
   * Actualisation manuelle : invalide le cache de la plateforme et relit. Ne contourne PAS le budget LinkedIn :
   * budget connu épuisé -> aucun appel ; relecture dégradée par le budget -> les données précédentes sont conservées.
   * Retourne { status: 'refreshed' | 'budget_exhausted', refreshed, updatedAt, budget }.
   */
  async refreshPlatform(platform) {
    const before = this.fetchedAt[platform] || null;
    if (platform === 'linkedin') {
      const b = this.linkedinBudget();
      if (b && b.exhausted) return { status: 'budget_exhausted', refreshed: false, updatedAt: before, budget: { used: b.used, limit: b.limit, resetsAt: b.resetsAt } };
    }
    const previous = this.slots[platform] ? { ...this.slots[platform] } : null;
    const raw = await this.platformRaw(platform, { force: true });
    if (platform !== 'linkedin') return { status: 'refreshed', refreshed: true, updatedAt: this.fetchedAt[platform] || null, budget: null };
    const d = (raw && raw.details) || {};
    const degraded = Object.values(d.blocks || {}).some((x) => x && x.state === 'budget_exhausted');
    const budget = d.budget ? { used: d.budget.used, limit: d.budget.limit, resetsAt: d.budget.resetsAt } : null;
    if (degraded && previous && previous.raw) { // on garde les données complètes précédentes plutôt qu'une lecture amputée
      this.slots[platform] = previous;
      this.cache.set(this.rawKey(platform), previous.raw, this.ttlMs(platform));
      this.fetchedAt[platform] = before;
      return { status: 'budget_exhausted', refreshed: false, updatedAt: before, budget };
    }
    return { status: degraded ? 'budget_exhausted' : 'refreshed', refreshed: true, updatedAt: this.fetchedAt[platform] || null, budget };
  }

  /**
   * Maintenance périodique.
   *  - mode 'full' (historique, LIVE_ENABLED=false) : tokens + relecture complète de chaque plateforme connectée ;
   *    LinkedIn (budget d'appels quotidien) n'est relu qu'au plus toutes les `linkedin.refreshIntervalHours` heures.
   *  - mode 'essential' (mode en direct) : uniquement ce qui doit continuer sans utilisateur : rafraîchissement des
   *    jetons avant expiration + instantané quotidien d'abonnés (1 appel léger par plateforme et par jour).
   */
  async refreshAll({ mode = 'full' } = {}) {
    this.cache.purgeExpired();
    // Le renouvellement des jetons ne dépend jamais de la présence d'un utilisateur : le mode essentiel le fait via freshToken,
    // le mode complet l'effectue d'abord ici (LinkedIn peut être sauté par son intervalle de relecture).
    if (mode === 'essential') return this.essentialMaintenance();
    await this.renewDueTokens();
    for (const p of PLATFORMS) {
      if (this.providers[p].pendingApproval || !(await this.store.getToken(p))) continue;
      if (p === 'linkedin' && this.fetchedAt[p] && this.now() - Date.parse(this.fetchedAt[p]) < this.cfg.linkedin.refreshIntervalHours * 3_600_000) continue;
      try {
        await this.platformRaw(p, { force: true });
      } catch (err) {
        this.logger.warn({ platform: p, code: err.code }, `rafraîchissement périodique en échec : ${err.message}`);
      }
    }
  }

  async essentialMaintenance() {
    const today = isoDay(this.now());
    for (const p of PLATFORMS) {
      const provider = this.providers[p];
      if (provider.pendingApproval || !(await this.store.getToken(p))) continue;
      try {
        const token = await this.freshToken(p); // rafraîchit le jeton s'il approche de l'échéance
        if (!token) continue;
        if ((await this.store.getSnapshots(p))[today] !== undefined) continue; // instantané du jour déjà pris
        if (p === 'linkedin') {
          // Pas d'appel léger possible : lecture budgétée, au plus une fois par intervalle de relecture LinkedIn.
          if (this.fetchedAt[p] && this.now() - Date.parse(this.fetchedAt[p]) < this.cfg.linkedin.refreshIntervalHours * 3_600_000) continue;
          await this.platformRaw(p, { force: true });
        } else if (typeof provider.fetchFollowers === 'function') {
          const followers = await provider.fetchFollowers(token);
          if (Number.isFinite(followers)) await this.store.recordSnapshot(p, today, followers);
        } else {
          await this.platformRaw(p, { force: true });
        }
      } catch (err) {
        this.logger.warn({ platform: p, code: err.code }, `maintenance essentielle en échec : ${err.message}`);
      }
    }
  }

  /** Une plateforme peut-elle être actualisée en direct ? Connectée, approuvée, jeton non expiré (jamais LinkedIn). */
  async liveEligible(platform) {
    if (platform === 'linkedin' || !this.hasTier(platform)) return false;
    if (this.providers[platform].pendingApproval) return false;
    const token = await this.store.getToken(platform);
    if (!token || token.expiresAt <= this.now()) return false;
    const last = this.lastResult[platform];
    return !(last && (last.status === 'expired' || last.status === 'pending_approval'));
  }

  /** Âges des paliers d'une plateforme (ms) pour l'ordonnanceur. */
  tierTimes(platform) {
    const slot = this.slots[platform];
    return { lightAt: slot ? slot.lightAt : null, heavyAt: slot ? slot.heavyAt : null };
  }

  invalidate(platform) { this.cache.invalidate(platform ? `raw:${platform}` : ''); }

  // ------------------------------------------------------------ Cache persistant (cache.enc.json)
  /** Ce qui peut être écrit sur disque : jamais de commentaire, de jeton ni d'activité de membres LinkedIn. */
  persistable(platform, slot) {
    const raw = slot.raw;
    const base = { lightAt: slot.lightAt, heavyAt: slot.heavyAt, fetchedAt: this.fetchedAt[platform] || null, limited: Boolean(raw.limited) };
    if (platform === 'linkedin') {
      // Conformité : uniquement les statistiques de Page (≤ 1 an). Ni publications (réactions de membres), ni commentaires.
      return { ...base, data: scrub({ account: raw.account, followers: raw.followers, dailyViews: raw.dailyViews, dailyNewFollowers: raw.dailyNewFollowers }) };
    }
    const data = scrub({
      account: raw.account, followers: raw.followers, dailyViews: raw.dailyViews, dailyNewFollowers: raw.dailyNewFollowers,
      posts: (raw.posts || []).slice(0, MAX_PERSISTED_POSTS), notes: raw.notes, details: raw.details
    });
    const insights = {};
    for (const [period, e] of Object.entries(this.insightSlots[platform] || {})) insights[period] = { at: e.at, body: scrub(e.body) };
    return { ...base, data, insights };
  }

  markDirty() {
    if (!this.cacheFile || !this.cfg.persistCache) return;
    this.dirty = true;
    if (this.persistTimer) return;
    this.persistTimer = setTimeout(() => { this.persistTimer = null; this.flushCache().catch(() => {}); }, PERSIST_DELAY_MS);
    this.persistTimer.unref?.();
  }

  /** Écrit immédiatement le cache persistant si des changements sont en attente. */
  async flushCache() {
    if (!this.cacheFile || !this.cfg.persistCache || !this.dirty) return false;
    this.dirty = false;
    const platforms = {};
    for (const p of PLATFORMS) if (this.slots[p] && this.slots[p].raw) platforms[p] = this.persistable(p, this.slots[p]);
    return this.cacheFile.save(platforms);
  }

  /**
   * Recharge le cache persistant au démarrage (premier affichage instantané). Les plateformes déconnectées depuis
   * sont purgées ; les données rechargées sont marquées partielles (commentaires et détails lourds absents).
   */
  async hydrate() {
    if (!this.cacheFile || !this.cfg.persistCache) return { restored: [], purged: [] };
    const file = await this.cacheFile.load();
    const restored = [];
    const purged = [];
    if (!file) return { restored, purged };
    for (const p of PLATFORMS) {
      const e = file.platforms[p];
      if (!e || !e.data) continue;
      const token = await this.store.getToken(p);
      if (!token || this.providers[p].pendingApproval) { purged.push(p); this.dirty = true; continue; }
      // Conservation bornée : une entrée plus ancienne que PERSIST_CACHE_MAX_AGE_DAYS est purgée, jamais réaffichée.
      const savedAt = Number.isFinite(e.lightAt) ? e.lightAt : Date.parse(e.fetchedAt);
      const maxAgeMs = (this.cfg.persistCacheMaxAgeDays || 7) * 86_400_000;
      if (!Number.isFinite(savedAt) || this.now() - savedAt > maxAgeMs) { purged.push(p); this.dirty = true; continue; }
      const posts = Array.isArray(e.data.posts) ? e.data.posts : [];
      const raw = {
        ...e.data,
        posts,
        comments: p === 'tiktok' ? null : [],
        details: e.data.details || null,
        notes: e.data.notes || [],
        limited: Boolean(e.limited),
        partial: true
      };
      const lightAt = Number.isFinite(e.lightAt) ? e.lightAt : Date.parse(e.fetchedAt) || this.now();
      this.slots[p] = { raw, lightAt, heavyAt: Number.isFinite(e.heavyAt) ? e.heavyAt : null, restored: true };
      this.fetchedAt[p] = e.fetchedAt || new Date(lightAt).toISOString();
      const left = this.ttlMs(p) - (this.now() - lightAt);
      if (p !== 'linkedin' && left > 0) this.cache.set(this.rawKey(p), raw, left);
      if (e.insights && typeof e.insights === 'object') {
        for (const [period, ent] of Object.entries(e.insights)) {
          if (!(ent && ent.body && Number.isFinite(ent.at))) continue;
          (this.insightSlots[p] ||= {})[period] = { body: ent.body, at: ent.at };
          const leftMs = this.cfg.cacheTtlSeconds * 1000 - (this.now() - ent.at);
          if (leftMs > 0) this.cache.set(this.insightKey(p, period), true, leftMs);
        }
      }
      restored.push(p);
    }
    for (const p of Object.keys(file.platforms)) if (!PLATFORMS.includes(p)) { purged.push(p); this.dirty = true; }
    if (this.dirty) await this.flushCache();
    return { restored, purged };
  }

  /** Arrêt propre : attend les lectures en cours (bornées) et écrit le cache. */
  async close() {
    if (this.persistTimer) { clearTimeout(this.persistTimer); this.persistTimer = null; }
    await Promise.race([this.settle(), new Promise((r) => { const t = setTimeout(r, 5000); t.unref?.(); })]);
    await this.flushCache();
  }
}
