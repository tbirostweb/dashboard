// Présence : « l'application est utilisée » = une requête authentifiée (routes de données) ou un battement
// POST /api/live/ping durant les `windowMs` dernières millisecondes. Horloge injectable.
export class Presence {
  constructor({ windowMs = 90_000, now = () => Date.now() } = {}) {
    this.windowMs = windowMs;
    this.now = now;
    this.lastSeenAt = null;
    this.listeners = new Set();
  }

  /** Enregistre une activité. Renvoie true s'il s'agit d'une REPRISE (l'application était inactive). */
  touch() {
    const resumed = !this.active();
    this.lastSeenAt = this.now();
    if (resumed) for (const fn of [...this.listeners]) { try { fn(); } catch { /* un écouteur défaillant ne casse pas la requête */ } }
    return resumed;
  }

  active() {
    return this.lastSeenAt !== null && this.now() - this.lastSeenAt < this.windowMs;
  }

  /** Abonnement aux reprises ; renvoie la fonction de désabonnement. */
  onResume(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }

  snapshot() {
    return {
      active: this.active(),
      windowSeconds: Math.round(this.windowMs / 1000),
      lastActivityAt: this.lastSeenAt === null ? null : new Date(this.lastSeenAt).toISOString(),
      activeUntil: this.active() ? new Date(this.lastSeenAt + this.windowMs).toISOString() : null
    };
  }
}
