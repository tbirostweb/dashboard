// Cache persistant chiffré du dernier jeu de données valide (AES-256-GCM, même clé que le store de jetons).
// Fichier SÉPARÉ de store.enc.json : cache.enc.json. Écriture atomique (fichier temporaire + rename), mode 0600,
// version de schéma, taille bornée. Une lecture ratée (fichier absent, corrompu, autre clé, autre version) n'est
// jamais fatale : le cache est simplement ignoré. NE CONTIENT JAMAIS de jeton, d'état OAuth ni de commentaire.
import fs from 'node:fs/promises';
import path from 'node:path';
import { encrypt, decrypt } from './crypto.js';

export const CACHE_SCHEMA = 1;
export const CACHE_MAX_BYTES = 6 * 1024 * 1024;

// Clés d'URL d'image signées qui expirent : jamais persistées.
const EXPIRING_URL = /(avatar|cover|thumbnail|picture|image).*url$/i;
// Clés qui ne doivent jamais apparaître dans le fichier, quel que soit le contenu du jeu de données.
const FORBIDDEN_KEYS = /token|secret|password|authorization|cookie|api[_-]?key|nonce|oauth/i;

/** Copie profonde sans clés interdites ni URL d'image expirables (les URL sont remplacées par null). */
export function scrub(value, depth = 0) {
  if (depth > 12) return null;
  if (Array.isArray(value)) return value.map((v) => scrub(v, depth + 1));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (FORBIDDEN_KEYS.test(k)) continue;
      if (/^comments?$/i.test(k) && Array.isArray(v)) continue; // listes de commentaires (texte, auteurs) : jamais ; les compteurs numériques restent
      out[k] = EXPIRING_URL.test(k) ? null : scrub(v, depth + 1);
    }
    return out;
  }
  return value;
}

export class CacheFile {
  constructor({ dataDir, keyHex, fileName = 'cache.enc.json', maxBytes = CACHE_MAX_BYTES, logger = null }) {
    this.file = path.join(dataDir, fileName);
    this.keyHex = keyHex;
    this.maxBytes = maxBytes;
    this.logger = logger;
    this.queue = Promise.resolve();
  }

  /** Renvoie { schema, savedAt, platforms } ou null (absent, illisible, corrompu, version inconnue, trop gros). */
  async load() {
    try {
      const stat = await fs.stat(this.file);
      if (stat.size > this.maxBytes * 2) { this.logger?.warn?.('cache persistant ignoré : fichier trop volumineux'); return null; }
      const box = JSON.parse(await fs.readFile(this.file, 'utf8'));
      const data = JSON.parse(decrypt(box, this.keyHex));
      if (!data || data.schema !== CACHE_SCHEMA || typeof data.platforms !== 'object' || data.platforms === null) {
        this.logger?.warn?.('cache persistant ignoré : version de schéma inconnue');
        return null;
      }
      return data;
    } catch (err) {
      if (err.code !== 'ENOENT') this.logger?.warn?.('cache persistant ignoré : fichier illisible ou clé différente');
      return null;
    }
  }

  /** Écrit l'état ({ platforms }) ; sérialise les écritures. Renvoie true si écrit. */
  save(platforms) {
    const job = this.queue.then(async () => {
      const state = { schema: CACHE_SCHEMA, savedAt: new Date().toISOString(), platforms };
      const plain = JSON.stringify(state);
      if (Buffer.byteLength(plain) > this.maxBytes) {
        this.logger?.warn?.('cache persistant non écrit : taille maximale dépassée');
        return false;
      }
      await fs.mkdir(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.${process.pid}.tmp`;
      await fs.writeFile(tmp, JSON.stringify(encrypt(plain, this.keyHex)), { mode: 0o600 });
      await fs.rename(tmp, this.file);
      return true;
    });
    this.queue = job.catch(() => {});
    return job.catch((err) => { this.logger?.warn?.(`cache persistant non écrit : ${err.code || 'erreur'}`); return false; });
  }

  async remove() {
    await this.queue;
    await fs.rm(this.file, { force: true });
  }
}
