// Stockage persistant chiffré (AES-256-GCM) : tokens OAuth + instantanés quotidiens de followers.
// Un seul fichier JSON dans DATA_DIR (volume /data). Écriture atomique (fichier temporaire + rename), mode 0600.
import fs from 'node:fs/promises';
import path from 'node:path';
import { encrypt, decrypt } from './crypto.js';

const EMPTY = () => ({ tokens: {}, snapshots: {} });
const MAX_SNAPSHOT_DAYS = 400;

export class Store {
  constructor({ dataDir, keyHex, fileName = 'store.enc.json' }) {
    this.file = path.join(dataDir, fileName);
    this.keyHex = keyHex;
    this.state = null;
    this.queue = Promise.resolve();
  }

  async load() {
    if (this.state) return this.state;
    try {
      const raw = await fs.readFile(this.file, 'utf8');
      this.state = { ...EMPTY(), ...JSON.parse(decrypt(JSON.parse(raw), this.keyHex)) };
    } catch (err) {
      if (err.code === 'ENOENT') this.state = EMPTY();
      else if (err.code === 'EACCES' || err.code === 'EPERM') {
        throw new Error(`Accès refusé à ${this.file} (${err.code}) : le volume de données doit appartenir à l'utilisateur node (uid 1000).`);
      } else throw new Error('Impossible de déchiffrer le stockage des tokens (TOKEN_ENCRYPTION_KEY a changé ou fichier corrompu).');
    }
    return this.state;
  }

  /** Vérifie au démarrage que DATA_DIR est inscriptible (sinon l'échec n'apparaîtrait qu'à la première connexion OAuth). */
  async assertWritable() {
    const dir = path.dirname(this.file);
    const probe = path.join(dir, `.write-test.${process.pid}`);
    try {
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(probe, '', { mode: 0o600 });
      await fs.rm(probe, { force: true });
    } catch (err) {
      const uid = typeof process.getuid === 'function' ? process.getuid() : '?';
      throw new Error(`Le dossier de données ${dir} n'est pas inscriptible par l'utilisateur uid ${uid} (${err.code || err.message}). ` +
        `Vérifiez le volume monté sur ${dir} (propriétaire attendu : node, uid 1000).`);
    }
  }

  /** Sérialise les écritures pour éviter les courses entre requêtes concurrentes. */
  save() {
    this.queue = this.queue.then(async () => {
      await fs.mkdir(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.${process.pid}.tmp`;
      await fs.writeFile(tmp, JSON.stringify(encrypt(JSON.stringify(this.state), this.keyHex)), { mode: 0o600 });
      await fs.rename(tmp, this.file);
    });
    return this.queue;
  }

  async getToken(platform) {
    const s = await this.load();
    return s.tokens[platform] || null;
  }

  async setToken(platform, token) {
    const s = await this.load();
    s.tokens[platform] = { ...token, updatedAt: new Date().toISOString() };
    await this.save();
  }

  async deleteToken(platform) {
    const s = await this.load();
    delete s.tokens[platform];
    if (s.tokenMeta) delete s.tokenMeta[platform];
    await this.save();
  }

  /** Métadonnées NON sensibles du renouvellement (dates, échec générique) : jamais de jeton. */
  async getTokenMeta(platform) {
    const s = await this.load();
    return (s.tokenMeta || {})[platform] || null;
  }

  async setTokenMeta(platform, meta) {
    const s = await this.load();
    if (!meta && !(s.tokenMeta && s.tokenMeta[platform])) return;
    s.tokenMeta = s.tokenMeta || {}; // clé créée à la demande : absente tant qu'aucun renouvellement n'a été mémorisé
    if (meta) s.tokenMeta[platform] = meta; else delete s.tokenMeta[platform];
    await this.save();
  }

  async getSnapshots(platform) {
    const s = await this.load();
    return s.snapshots[platform] || {};
  }

  /** Enregistre le nombre de followers du jour (une valeur par date, la dernière gagne). */
  async recordSnapshot(platform, date, followers) {
    if (!Number.isFinite(followers)) return;
    const s = await this.load();
    const snaps = (s.snapshots[platform] ||= {});
    if (snaps[date] === followers) return;
    snaps[date] = followers;
    const dates = Object.keys(snaps).sort();
    dates.slice(0, Math.max(0, dates.length - MAX_SNAPSHOT_DAYS)).forEach((d) => delete snaps[d]);
    await this.save();
  }

  async clearPlatform(platform) {
    const s = await this.load();
    delete s.tokens[platform];
    delete s.snapshots[platform];
    if (s.tokenMeta) delete s.tokenMeta[platform];
    await this.save();
  }
}
