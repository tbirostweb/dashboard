// Ordonnanceur du mode en direct : actualise Instagram et TikTok UNIQUEMENT tant que l'application est utilisée.
//  - palier léger (compteurs, médias récents) et palier lourd (insights par média, audience, commentaires, historique) ;
//  - jamais LinkedIn (100 appels/jour/membre : cadencement existant + actualisation manuelle budgétée) ;
//  - jamais pour une plateforme non connectée, en attente d'approbation ou au jeton expiré ;
//  - un seul cycle à la fois par plateforme, jitter ±10 %, timers `unref`, arrêt propre ;
//  - s'arrête dès que la présence tombe (aucun timer ne reste armé) et reprend au premier battement ;
//  - ralentit seul quand le quota Meta observé dépasse 70 % ; backoff exponentiel sur erreur / 429.
// Horloge, timers et aléa sont injectables (tests déterministes).
import { slowdownFactor } from './meter.js';

export const LIVE_PLATFORMS = ['tiktok', 'instagram']; // LinkedIn n'y figure jamais, par construction
export const JITTER = 0.1;
const MIN_DELAY_MS = 1000;
const BACKOFF_MAX_MS = 15 * 60_000;

export class Scheduler {
  constructor({ service, presence, cfg, now = () => Date.now(), setTimer = setTimeout, clearTimer = clearTimeout, random = Math.random, logger = null }) {
    Object.assign(this, { service, presence, cfg, now, setTimer, clearTimer, random, logger });
    this.timers = new Map();   // plateforme -> timer armé
    this.running = new Set();  // plateformes en cours de cycle
    this.failures = {};        // plateforme -> erreurs consécutives
    this.retryAt = {};         // plateforme -> ms : pas de nouvelle tentative avant (backoff, plateforme inéligible)
    this.started = false;
    this.unsubscribe = null;
  }

  intervals(platform) {
    const l = this.cfg.live;
    return platform === 'instagram'
      ? { light: l.instagramLightSeconds * 1000, heavy: l.instagramHeavySeconds * 1000 }
      : { light: l.tiktokLightSeconds * 1000, heavy: l.tiktokHeavySeconds * 1000 };
  }

  jitter(ms) { return Math.round(ms * (1 + (this.random() * 2 - 1) * JITTER)); }

  /** Facteur de ralentissement selon le quota Meta observé (70 % -> x2, 90 % -> x4). Le backoff d'erreur passe par retryAt. */
  factor(platform) {
    return platform === 'instagram' ? slowdownFactor(this.service.meter.usagePercent('instagram')) : 1;
  }

  start() {
    if (this.started || !this.cfg.live.enabled) return this;
    this.started = true;
    this.unsubscribe = this.presence.onResume(() => this.onResume());
    if (this.presence.active()) this.onResume();
    return this;
  }

  stop() {
    this.started = false;
    this.unsubscribe?.();
    this.unsubscribe = null;
    for (const t of this.timers.values()) this.clearTimer(t);
    this.timers.clear();
  }

  /** Reprise de présence : relance immédiatement le palier léger échu, arme les timers des autres plateformes. */
  onResume() {
    if (!this.started) return;
    for (const p of LIVE_PLATFORMS) {
      if (this.timers.has(p) || this.running.has(p)) continue;
      if (this.dueAt(p) <= this.now()) this.cycle(p).catch(() => {});
      else this.schedule(p);
    }
  }

  /** Prochaine échéance (ms) : premier palier échu, repoussée par un éventuel backoff. */
  dueAt(platform) {
    const { light, heavy } = this.intervals(platform);
    const { lightAt, heavyAt } = this.service.tierTimes(platform);
    const f = this.factor(platform);
    const natural = Math.min((lightAt ?? -Infinity) + light * f, (heavyAt ?? -Infinity) + heavy * f);
    return Math.max(natural, this.retryAt[platform] || 0);
  }

  /** Arme le prochain cycle à l'échéance, avec jitter ±10 % (jamais en dessous de 1 s). */
  schedule(platform) {
    if (!this.started) return;
    const old = this.timers.get(platform);
    if (old) this.clearTimer(old);
    const delay = Math.max(MIN_DELAY_MS, this.jitter(Math.max(0, this.dueAt(platform) - this.now())));
    const timer = this.setTimer(() => { this.timers.delete(platform); this.cycle(platform).catch(() => {}); }, delay);
    timer.unref?.();
    this.timers.set(platform, timer);
  }

  async cycle(platform) {
    if (!this.started) return;
    if (!this.presence.active()) return; // personne : aucun appel, aucun timer ré-armé jusqu'au prochain battement
    if (this.running.has(platform)) return; // un seul cycle à la fois par plateforme
    this.running.add(platform);
    const { light, heavy } = this.intervals(platform);
    try {
      if (await this.service.liveEligible(platform)) {
        const { lightAt, heavyAt } = this.service.tierTimes(platform);
        const f = this.factor(platform);
        const t = this.now();
        const heavyDue = heavyAt === null || t - heavyAt >= heavy * f;
        const lightDue = lightAt === null || t - lightAt >= light * f;
        if (heavyDue) {
          // Démarrage à froid : le léger passe TOUJOURS d'abord (réponse partielle rapide, jamais attendue derrière le lourd) ;
          // s'il échoue, il lève : backoff, et le lourd n'est pas lancé (quota préservé).
          if (lightAt === null) await this.service.runTier(platform, 'light');
          await this.service.runTier(platform, 'heavy');
          if (this.presence.active()) await this.service.refreshInsightsKnown?.(platform);
        } else if (lightDue) {
          await this.service.runTier(platform, 'light');
        }
        this.failures[platform] = 0;
        delete this.retryAt[platform];
      } else {
        this.retryAt[platform] = this.now() + light; // non connectée / en attente / expirée : on revérifie sans appeler le fournisseur
      }
    } catch (err) {
      this.failures[platform] = Math.min((this.failures[platform] || 0) + 1, 6);
      this.retryAt[platform] = this.now() + Math.min(light * 2 ** this.failures[platform], BACKOFF_MAX_MS);
      this.logger?.warn?.({ platform, code: err && err.code }, `actualisation en direct en échec : ${err && err.message}`);
    } finally {
      this.running.delete(platform);
    }
    if (!this.presence.active()) return; // la présence est tombée pendant le cycle : on s'arrête là
    this.schedule(platform);
  }

  /** Pour le diagnostic : prochaines échéances (sans secret). */
  snapshot() {
    return { started: this.started, armed: [...this.timers.keys()], running: [...this.running] };
  }
}
