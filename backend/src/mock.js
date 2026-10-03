// Charge data/mock.js (script navigateur) dans un bac à sable vm pour réutiliser les données de démo côté serveur.
// Le jeu est régénéré chaque jour (il est ancré sur la date du jour).
import fs from 'node:fs';
import vm from 'node:vm';
import { isoDay } from './util.js';

export function createMockSource(mockPath, now = () => Date.now()) {
  let cache = null;
  let code = null;
  return {
    available: Boolean(mockPath && fs.existsSync(mockPath)),
    get() {
      if (!this.available) return null;
      const day = isoDay(now());
      if (cache && cache.day === day) return cache.data;
      code ||= fs.readFileSync(mockPath, 'utf8');
      const sandbox = { window: {} };
      vm.runInNewContext(code, sandbox, { filename: 'mock.js', timeout: 2000 });
      // Copie via JSON : objets "natifs" du contexte principal
      cache = { day, data: JSON.parse(JSON.stringify(sandbox.window.MOCK_DATA)) };
      return cache.data;
    }
  };
}
