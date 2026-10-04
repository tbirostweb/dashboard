// Point d'entrée : configuration, stockage chiffré, connecteurs, serveur HTTP, rafraîchissement périodique.
import { loadConfig, assertSecrets, securityWarnings, ConfigError } from './config.js';
import { Store } from './store.js';
import { TtlCache } from './cache.js';
import { createProviders } from './providers/index.js';
import { createMockSource } from './mock.js';
import { DataService } from './service.js';
import { buildApp } from './app.js';
import { DokployClient } from './dokploy.js';
import { Presence } from './presence.js';
import { Scheduler } from './scheduler.js';
import { CallMeter } from './meter.js';
import { CacheFile } from './cachefile.js';
import { createKeepAliveFetch } from './net.js';
import WebSocket from 'ws';

async function main() {
  const cfg = loadConfig();
  try {
    assertSecrets(cfg);
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(err.message);
      process.exit(1);
    }
    throw err;
  }

  const store = new Store({ dataDir: cfg.dataDir, keyHex: cfg.tokenEncryptionKey });
  await store.assertWritable(); // message explicite si le volume /data appartient à root
  await store.load(); // échoue immédiatement si la clé de chiffrement ne correspond pas au fichier existant

  // Connexions HTTP persistantes pour tous les appels sortants ; le compteur d'appels/heure enrobe le transport des fournisseurs.
  const http = createKeepAliveFetch();
  const meter = new CallMeter();
  const providers = createProviders(cfg, { fetch: meter.wrap(http.fetch) });
  const dokploy = new DokployClient(cfg.dokploy, { fetch: http.fetch, createSocket: (url, opts) => new WebSocket(url, opts) });
  const cache = new TtlCache({ ttlMs: cfg.cacheTtlSeconds * 1000 });
  const mock = createMockSource(cfg.mockPath);
  const presence = new Presence({ windowMs: cfg.live.activeWindowSeconds * 1000 });
  let scheduler = null;
  const app = buildApp({
    cfg, store, providers, dokploy, presence,
    createService: (logger) => new DataService({
      cfg, store, providers, cache, mock, logger, meter, presence,
      cacheFile: cfg.persistCache ? new CacheFile({ dataDir: cfg.dataDir, keyHex: cfg.tokenEncryptionKey, logger }) : null
    })
  });
  const { service } = app;
  const restored = await service.hydrate(); // premier affichage instantané après un redémarrage
  if (restored.restored.length || restored.purged.length) app.log.info(restored, 'cache persistant rechargé');
  // Arrêt propre (SIGTERM) : plus de cycle en direct, lectures en cours terminées, cache écrit, puis connexions fermées.
  app.addHook('onClose', async () => { scheduler?.stop(); await service.close(); await http.close(); });

  await app.listen({ port: cfg.port, host: cfg.host });
  app.log.info({ mockFallback: cfg.mockFallback, mock: mock.available, publicUrl: cfg.publicUrl }, 'API démarrée');
  for (const warning of securityWarnings(cfg)) app.log.warn(`sécurité : ${warning}`); // aucun secret dans ces messages

  if (cfg.live.enabled) {
    scheduler = new Scheduler({ service, presence, cfg, logger: app.log }).start();
    app.log.info({ windowSeconds: cfg.live.activeWindowSeconds }, 'mode en direct actif (pause sans utilisateur)');
  }

  // Renouvellement des jetons indépendant de l'activité et de REFRESH_INTERVAL_HOURS : vérification toutes les 15 min
  // (aucun appel réseau tant qu'aucun jeton n'est au seuil ; backoff d'au moins 15 min après un échec).
  const renewTick = () => service.renewDueTokens().catch((err) => app.log.warn({ code: err && err.code }, 'renouvellement des jetons en échec'));
  setTimeout(renewTick, 10_000).unref();
  setInterval(renewTick, 15 * 60_000).unref();

  if (cfg.refreshIntervalHours > 0) {
    // En mode direct : uniquement l'essentiel (jetons, instantané quotidien) ; sinon relecture complète périodique.
    const run = () => service.refreshAll({ mode: cfg.live.enabled ? 'essential' : 'full' }).catch((err) => app.log.warn(`refreshAll : ${err.message}`));
    setTimeout(run, 30_000).unref();
    setInterval(run, cfg.refreshIntervalHours * 3_600_000).unref();
  }

  const stop = async (sig) => {
    app.log.info(`${sig} reçu, arrêt…`);
    await app.close();
    process.exit(0);
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}

main().catch((err) => {
  console.error(`Démarrage impossible : ${err.message}`);
  process.exit(1);
});
