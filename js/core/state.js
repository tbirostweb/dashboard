/* État partagé de l'interface : période, route, filtres. Le stockage local est protégé (navigation privée, stockage bloqué). */
export const store = {
  get(key) { try { return localStorage.getItem(key); } catch (e) { return null; } },
  set(key, value) { try { localStorage.setItem(key, String(value)); } catch (e) { /* stockage indisponible */ } },
  sessionGet(key) { try { return sessionStorage.getItem(key); } catch (e) { return null; } },
  sessionSet(key, value) { try { sessionStorage.setItem(key, value); } catch (e) { /* ignore */ } },
  sessionRemove(key) { try { sessionStorage.removeItem(key); } catch (e) { /* ignore */ } }
};

export const PERIODS = [7, 30, 90];

export const state = {
  period: 30,
  route: 'overview',
  renderId: 0,
  postSort: 'publishedAt',
  comments: { platform: '', sentiment: '', q: '', shown: 25 },
  // Choix d'affichage conservés pendant la session et lors des mises à jour silencieuses (métrique du graphique par plateforme, population d'audience)
  ui: { metric: {}, aud: null },
  // Filtres Dokploy (services et déploiements)
  filters: { services: { q: '', project: '', status: '' }, deployments: { q: '', project: '', status: '' } }
};

{ const p = Number(store.get('sd.period')); if (PERIODS.includes(p)) state.period = p; }

export function setPeriod(p) {
  if (!PERIODS.includes(p)) return;
  state.period = p;
  store.set('sd.period', p);
}
