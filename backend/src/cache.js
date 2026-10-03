// Cache mémoire à TTL, avec déduplication des requêtes concurrentes (une seule requête en vol par clé).
export class TtlCache {
  constructor({ ttlMs, now = () => Date.now() }) {
    this.ttlMs = ttlMs;
    this.now = now;
    this.map = new Map();
    this.inflight = new Map();
  }

  get(key) {
    const e = this.map.get(key);
    if (!e) return undefined;
    if (e.expires <= this.now()) { this.map.delete(key); return undefined; }
    return e.value;
  }

  set(key, value, ttlMs = this.ttlMs) {
    this.purgeExpired();
    this.map.set(key, { value, expires: this.now() + ttlMs });
  }

  /** Retire les entrées échues (sinon une valeur jamais relue resterait en mémoire au-delà de son TTL). */
  purgeExpired() {
    const t = this.now();
    for (const [k, e] of this.map) if (e.expires <= t) this.map.delete(k);
  }

  delete(key) { this.map.delete(key); }

  /** Supprime toutes les clés commençant par prefix. */
  invalidate(prefix = '') {
    for (const k of this.map.keys()) if (k.startsWith(prefix)) this.map.delete(k);
  }

  async wrap(key, fn, ttlMs) {
    const hit = this.get(key);
    if (hit !== undefined) return hit;
    if (this.inflight.has(key)) return this.inflight.get(key);
    const p = (async () => {
      try {
        const v = await fn();
        this.set(key, v, ttlMs);
        return v;
      } finally {
        this.inflight.delete(key);
      }
    })();
    this.inflight.set(key, p);
    return p;
  }
}
