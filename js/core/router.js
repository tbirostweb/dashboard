/* Routeur par hash. Chaque route charge sa feature par import() dynamique ; une feature exporte
     title (texte ou (params) => texte), eyebrow (texte ou ''), usesToolbar (true si elle rend Toolbar : le sélecteur de période de l'en-tête est alors masqué),
     render(ctx) → { markup, after? } avec ctx = { state, params, route, period, announce, rerender }.
   Routes : #/overview · #/social · #/social/{instagram|tiktok|linkedin|comments} · #/infrastructure · #/deployments · #/settings.
   Anciennes routes (#/instagram, #/tiktok, #/linkedin, #/comments) → redirigées vers #/social/…. */
import { state, setPeriod, PERIODS } from './state.js?v=15';
import { PLATFORMS, PLATFORM_LABELS as LABELS } from './labels.js?v=15';
import { Breadcrumb, Tabs, Skeleton, resetDataTables, clearTableRestore } from '../ui/components.js?v=15';
import { initTracker } from '../features/deploy-tracker.js?v=15';
import { errorCard, refreshShell, readOAuthReturn, bindConnections, handleConnAction, flash } from '../features/connections.js?v=15';
import { esc } from './format.js?v=15';
import { SOCIAL_TABS } from '../features/tabs.js?v=15';
import { Live } from './live.js?v=15';
import { parseRetryAfter } from './live-logic.js?v=15';

const Api = window.Api, Charts = window.Charts;
const V = '?v=15';
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const SOCIAL_PARENT = { label: 'Réseaux sociaux', href: '#/social' };
export const ROUTES = {
  overview: { nav: 'overview', social: true, skeleton: 'page', load: () => import(`../features/overview.js${V}`) },
  social: { nav: 'social', social: true, skeleton: 'page', load: () => import(`../features/social.js${V}`) },
  'social/instagram': { nav: 'social', social: true, skeleton: 'page', params: { platform: 'instagram' }, parent: SOCIAL_PARENT, load: () => import(`../features/platform.js${V}`) },
  'social/tiktok': { nav: 'social', social: true, skeleton: 'page', params: { platform: 'tiktok' }, parent: SOCIAL_PARENT, load: () => import(`../features/platform.js${V}`) },
  'social/linkedin': { nav: 'social', social: true, skeleton: 'page', params: { platform: 'linkedin' }, parent: SOCIAL_PARENT, load: () => import(`../features/platform.js${V}`) },
  'social/comments': { nav: 'social', social: true, skeleton: 'table', parent: SOCIAL_PARENT, load: () => import(`../features/comments.js${V}`) },
  infrastructure: { nav: 'infrastructure', skeleton: 'infra', load: () => import(`../features/infrastructure.js${V}`) },
  deployments: { nav: 'deployments', skeleton: 'table', load: () => import(`../features/deployments.js${V}`) },
  settings: { nav: 'settings', skeleton: 'settings', load: () => import(`../features/settings.js${V}`) }
};
const LEGACY = { instagram: 'social/instagram', tiktok: 'social/tiktok', linkedin: 'social/linkedin', comments: 'social/comments' };
const DOKPLOY_ROUTES = ['overview', 'infrastructure', 'deployments'];
const isSocialKey = (k) => Boolean(ROUTES[k] && ROUTES[k].nav === 'social');

const content = $('#content');
let currentKey = null, renderedKey = null;

export function announce(msg) {
  const el = $('#sr-status'); if (!el) return;
  el.textContent = '';
  setTimeout(() => { el.textContent = msg; }, 30);
}

/** Clé de route depuis le hash ; les anciennes routes sont redirigées (sans entrée d'historique). */
export function routeFromHash() {
  const raw = location.hash.replace(/^#\/?/, '').replace(/\/+$/, '').split('?')[0];
  if (LEGACY[raw]) { history.replaceState(null, '', `${location.pathname}${location.search}#/${LEGACY[raw]}`); return LEGACY[raw]; }
  return ROUTES[raw] ? raw : 'overview';
}

let rendering = false, lastResult = null, lastKeys = [];
/** Attributs qui identifient un élément à re-focaliser après un remplacement silencieux du contenu. */
const FOCUS_ATTRS = ['data-redeploy', 'data-reload', 'data-logs', 'data-dt-sort', 'data-dt-page', 'data-metric', 'data-aud', 'data-refresh', 'data-conn-act'];
function focusSelector(el) {
  if (!el || el === document.body || !content.contains(el)) return null;
  if (el.id) return `#${CSS.escape(el.id)}`;
  for (const attr of FOCUS_ATTRS) if (el.hasAttribute(attr)) return `[${attr}="${CSS.escape(el.getAttribute(attr))}"]`;
  if (el.getAttribute('role') === 'tab') return '[role="tab"][aria-selected="true"]';
  return null;
}
/** État d'interface à conserver quand le contenu est remplacé en silence : défilement, panneaux repliables ouverts, focus. */
function captureUi() {
  return { y: window.scrollY, details: $$('details', content).map((d) => d.open), focus: focusSelector(document.activeElement) };
}
function restoreUi(ui) {
  const all = $$('details', content);
  if (all.length === ui.details.length) all.forEach((d, i) => { if (d.open !== ui.details[i]) d.open = ui.details[i]; });
  window.scrollTo(0, ui.y);
  if (ui.focus) { const el = $(ui.focus, content); if (el && el !== document.activeElement && !el.disabled) el.focus({ preventScroll: true }); }
}

/**
 * Rendu d'une page. silent : mise à jour SILENCIEUSE de la page affichée (mode en direct) : aucun voile « Chargement », aucune annonce,
 * graphiques sans animation, défilement / panneaux ouverts / focus / recherche, filtres et page des tableaux conservés.
 */
async function render({ focus = false, silent = false } = {}) {
  if (silent && (rendering || currentKey !== renderedKey)) return false;
  const id = ++state.renderId;
  const key = currentKey, route = ROUTES[key];
  const sameRoute = key === renderedKey;
  const inTabs = Boolean(document.activeElement && document.activeElement.closest && document.activeElement.closest('[role="tablist"]'));
  state.route = key;
  rendering = true;
  if (!silent) {
    Live.routeChanged(key);
    $$('.nav a').forEach((a) => { if (a.dataset.route === route.nav) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current'); });
    content.setAttribute('aria-busy', 'true');
    // Même page (période, actualisation) : le contenu précédent reste, estompé, sans perdre le scroll ; nouvelle page : squelette de blocs (jamais un écran vide).
    if (sameRoute && content.firstElementChild) {
      content.classList.add('is-loading');
      if (!$('.loading-pill', content)) content.insertAdjacentHTML('afterbegin', '<p class="loading-pill" role="status">Chargement…</p>');
    } else {
      content.classList.remove('is-loading');
      content.innerHTML = Skeleton({ variant: route.skeleton || 'page' });
    }
  }
  let feature = null, title = '', eyebrow = '', ok = false;
  const tracker = Api.trackStart();
  try {
    feature = await route.load();
    title = typeof feature.title === 'function' ? feature.title(route.params || {}) : feature.title;
    eyebrow = feature.eyebrow || '';
    if (!silent) {
      document.title = `${title} — Social Dashboard`;
      $('#page-title').textContent = title;
      const eb = $('#page-eyebrow'); eb.textContent = eyebrow; eb.hidden = !eyebrow;
      const bc = $('#breadcrumb'); bc.innerHTML = route.parent ? Breadcrumb([{ label: 'Vue d’ensemble', href: '#/overview' }, route.parent, { label: title }]) : ''; bc.hidden = !route.parent;
      const seg = $('.topbar > .seg'); seg.hidden = !route.social || Boolean(feature.usesToolbar);
      $$('[data-period]').forEach((b) => b.setAttribute('aria-pressed', String(Number(b.dataset.period) === state.period)));
    }
    const ctx = { state, params: route.params || {}, route: key, period: state.period, announce, rerender, silent };
    if (!silent) resetDataTables(); else resetDataTables({ keep: true }); // avant render() : les DataTable créés pendant render() doivent survivre jusqu'à l'insertion du markup
    const result = await feature.render(ctx);
    if (id !== state.renderId) return false; // une navigation plus récente a eu lieu
    const ui = silent ? captureUi() : null;
    Charts.destroyAll();
    Charts.quiet(silent); // mise à jour silencieuse : graphiques recréés sans animation (pas de flash)
    if (silent) content.style.minHeight = `${content.offsetHeight}px`;
    content.innerHTML = result.markup;
    if (result.after) result.after();
    Charts.quiet(false);
    clearTableRestore();
    if (silent) { restoreUi(ui); content.style.minHeight = ''; }
    renderedKey = key;
    ok = true;
    await Promise.resolve(); await Promise.resolve(); // les lectures lancées par after() (commentaires) sont comptées dans le suivi
    const keys = Api.trackEnd(tracker);
    if (silent) { Live.silentDone(key, { result, keys }); } else { announce(`${title}, ${state.period} derniers jours chargés.`); }
    lastResult = result; lastKeys = keys;
  } catch (err) {
    Api.trackEnd(tracker); Charts.quiet(false); clearTableRestore();
    if (id !== state.renderId) return false;
    if (err && err.code === 'unauthenticated') return false; // redirection vers login.html en cours
    if (silent) { console.warn(err && err.message ? err.message : err); content.style.minHeight = ''; return false; } // la page reste telle quelle : jamais d'écran d'erreur sur une mise à jour de fond
    Charts.destroyAll(); resetDataTables();
    if (title === '') { $('#page-title').textContent = 'Erreur'; }
    content.innerHTML = (route.nav === 'social' && route.parent ? Tabs({ items: SOCIAL_TABS, current: key.split('/')[1], label: 'Réseaux sociaux' }) : '') + errorCard(err);
    renderedKey = key;
    lastResult = null; lastKeys = [];
    if (!(err && ['not_connected', 'token_expired', 'pending_approval'].includes(err.code))) console.warn(err.message || err);
  } finally {
    if (id === state.renderId) { rendering = false; if (!silent) { content.setAttribute('aria-busy', 'false'); content.classList.remove('is-loading'); } }
  }
  if (id !== state.renderId) return false;
  if (!silent) {
    if (focus) {
      const tab = inTabs && $('[role="tab"][aria-selected="true"]');
      (tab || $('#page-title')).focus({ preventScroll: true });
    }
    refreshShell({ isSocial: Boolean(route.social) });
    applyRefreshLocks();
    Live.routeReady(key, { result: ok && lastResult ? lastResult : {}, keys: ok ? lastKeys : [] });
  } else { refreshShell({ isSocial: Boolean(route.social) }); applyRefreshLocks(); }
  return ok;
}
export const rerender = () => render({});

// ---------------- Menu mobile ----------------
const sidebar = $('#sidebar'), backdrop = $('#backdrop'), toggle = $('#menu-toggle');
function setMenu(open) {
  sidebar.classList.toggle('is-open', open);
  backdrop.classList.toggle('is-open', open);
  backdrop.hidden = !open;
  toggle.setAttribute('aria-expanded', String(open));
  toggle.setAttribute('aria-label', open ? 'Fermer le menu' : 'Ouvrir le menu');
  if (open) $('.nav a', sidebar).focus();
}

// ---------------- Actualisation (POST /api/platforms/:p/refresh) ----------------
// Après un 429 (« actualisé il y a moins d'une minute »), le bouton reste bloqué pendant le délai annoncé par Retry-After.
const refreshLocks = new Map();
let lockTimer = null;
function applyRefreshLocks() {
  const t = Date.now();
  for (const [k, until] of refreshLocks) if (until <= t) refreshLocks.delete(k);
  $$('[data-refresh]').forEach((b) => {
    const until = refreshLocks.get(b.dataset.refresh);
    if (until) { b.disabled = true; b.setAttribute('aria-disabled', 'true'); b.title = `Disponible dans ${Math.max(1, Math.ceil((until - t) / 1000))} s`; b.dataset.locked = ''; }
    else if ('locked' in b.dataset) { b.disabled = false; b.removeAttribute('aria-disabled'); b.removeAttribute('title'); delete b.dataset.locked; }
  });
  clearTimeout(lockTimer); lockTimer = null;
  if (refreshLocks.size) lockTimer = setTimeout(applyRefreshLocks, Math.max(500, Math.min(...refreshLocks.values()) - Date.now()));
}
async function refreshData(btn) {
  const target = btn.dataset.refresh, list = target === 'all' ? PLATFORMS : [target];
  btn.disabled = true; btn.setAttribute('aria-busy', 'true');
  announce('Actualisation en cours…');
  Live.setBusy(true);
  for (const p of list) {
    try {
      const r = await Api.refreshPlatform(p);
      if (r && r.status === 'budget_exhausted') flash.push({ kind: 'info', html: esc(r.message || `${LABELS[p]} : budget d'appels atteint, données précédentes conservées.`) });
    } catch (err) {
      if (err && err.code === 'unauthenticated') { Live.setBusy(false); return; }
      if (target === 'all' && err && ['not_connected', 'pending_approval'].includes(err.code)) continue;
      if (err && err.status === 429) {
        const ms = parseRetryAfter(err.retryAfter || (err.data && err.data.retryAfter)) || 60000;
        refreshLocks.set(target, Math.max(refreshLocks.get(target) || 0, Date.now() + ms));
      }
      flash.push({ kind: 'err', html: esc(`${LABELS[p] || p} : ${(err && err.message) || 'actualisation impossible.'}`) });
    }
  }
  Api.invalidate();
  await render({});
  Live.setBusy(false);
  announce('Données actualisées.');
}

export function initRouter() {
  readOAuthReturn();
  bindConnections({ announce, rerender: () => render({ silent: true }), rerenderFull: () => render({}) });
  toggle.addEventListener('click', () => setMenu(!sidebar.classList.contains('is-open')));
  backdrop.addEventListener('click', () => setMenu(false));
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && sidebar.classList.contains('is-open')) { setMenu(false); toggle.focus(); } });
  $$('.nav a').forEach((a) => a.addEventListener('click', () => setMenu(false)));
  try { window.matchMedia('(min-width: 1280px)').addEventListener('change', (e) => { if (e.matches && sidebar.classList.contains('is-open')) setMenu(false); }); } catch (e) { /* ignore */ }

  document.addEventListener('click', async (e) => {
    const per = e.target.closest('[data-period]');
    if (per) { const p = Number(per.dataset.period); if (PERIODS.includes(p) && p !== state.period) { setPeriod(p); render({}); } return; }
    const ref = e.target.closest('[data-refresh]');
    if (ref) { if (!ref.disabled) refreshData(ref); return; }
    const conn = e.target.closest('[data-conn-act]');
    if (conn) { handleConnAction(conn); return; }
    if (e.target.closest('[data-logout-all]')) { await Api.logoutAll(); return; }
    if (e.target.closest('[data-logout]')) { await Api.logout(); }
  });

  window.addEventListener('hashchange', () => { currentKey = routeFromHash(); render({ focus: true }); window.scrollTo(0, 0); });
  currentKey = routeFromHash();
  initTracker({ onDone: () => { if (DOKPLOY_ROUTES.includes(currentKey)) render({}); } });
  Live.init({ silentRender: () => render({ silent: true }), announce });
  Api.onData((info) => { if (info.path === '/status') refreshShell({ isSocial: Boolean(ROUTES[currentKey] && ROUTES[currentKey].social) }); else Live.onBackgroundData(info); });
  // Session vérifiée avant tout chargement de données (évite des 401 en rafale avant la redirection) ; le module de la page se charge pendant ce temps.
  if (ROUTES[currentKey]) ROUTES[currentKey].load().catch(() => {});
  Api.checkSession().then((ok) => { if (ok) render({}); });
}
