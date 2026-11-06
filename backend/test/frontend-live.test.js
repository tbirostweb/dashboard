// Tests PURS (sans DOM, sans réseau) de la logique du mode en direct du frontend : js/core/live-logic.js.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as L from '../../js/core/live-logic.js';

const T0 = 1_000_000_000_000;
const base = { enabled: true, authenticated: true, online: true, visible: true, lastInteractionAt: T0, now: T0 + 1000 };

test('planification : actif seulement si visible, interaction récente, en ligne, authentifié, préférence activée', () => {
  assert.deepEqual(L.liveState(base), { active: true, state: 'live' });
  assert.deepEqual(L.liveState({ ...base, visible: false }), { active: false, state: 'hidden' });
  assert.deepEqual(L.liveState({ ...base, online: false }), { active: false, state: 'offline' });
  assert.deepEqual(L.liveState({ ...base, authenticated: false }), { active: false, state: 'signed_out' });
  assert.deepEqual(L.liveState({ ...base, enabled: false }), { active: false, state: 'disabled' });
});

test('inactivité : pause après 5 minutes sans interaction, reprise à l’interaction suivante', () => {
  const idle = L.liveState({ ...base, now: T0 + 5 * 60_000 });
  assert.deepEqual(idle, { active: false, state: 'idle' });
  assert.equal(L.liveState({ ...base, now: T0 + 5 * 60_000 - 1 }).active, true);
  assert.equal(L.liveState({ ...base, lastInteractionAt: T0 + 5 * 60_000, now: T0 + 5 * 60_000 + 10 }).active, true);
  assert.equal(L.idleRemainingMs(T0, T0 + 60_000), 4 * 60_000);
  assert.ok(L.idleRemainingMs(T0, T0 + 6 * 60_000) < 0);
});

test('priorité des états : déconnecté > désactivé > hors ligne > masqué > inactif', () => {
  const all = { ...base, authenticated: false, enabled: false, online: false, visible: false, now: T0 + 9e6 };
  assert.equal(L.liveState(all).state, 'signed_out');
  assert.equal(L.liveState({ ...all, authenticated: true }).state, 'disabled');
  assert.equal(L.liveState({ ...all, authenticated: true, enabled: true }).state, 'offline');
  assert.equal(L.liveState({ ...all, authenticated: true, enabled: true, online: true }).state, 'hidden');
});

test('cadence des réseaux sociaux : 20 s, 5 s tant que des blocs se chargent', () => {
  assert.equal(L.socialIntervalMs(), 20_000);
  assert.equal(L.socialIntervalMs({ loading: true }), 5000);
});

test('backoff exponentiel plafonné puis remise à zéro au succès', () => {
  const d = (f) => L.backoffMs(f, 3000, 30_000);
  assert.deepEqual([0, 1, 2, 3, 4, 5, 9].map(d), [3000, 6000, 12_000, 24_000, 30_000, 30_000, 30_000]);
  // échec : backoff ; succès : cadence normale (le compteur d'échecs repart à 0 côté appelant)
  assert.equal(L.nextDelayMs({ ok: false, intervalMs: 3000, failures: 2, maxBackoffMs: 30_000 }), 12_000);
  assert.equal(L.nextDelayMs({ ok: true, intervalMs: 3000, elapsedMs: 200, failures: 0, maxBackoffMs: 30_000 }), 2800);
  assert.equal(L.backoffMs(-3, 3000, 30_000), 3000);
});

test('Retry-After : secondes, date HTTP, bornes, valeurs illisibles', () => {
  assert.equal(L.parseRetryAfter('12'), 12_000);
  assert.equal(L.parseRetryAfter('0'), 1000);
  assert.equal(L.parseRetryAfter('99999'), 300_000);
  assert.equal(L.parseRetryAfter(new Date(T0 + 7000).toUTCString(), T0), 7000);
  assert.equal(L.parseRetryAfter('n’importe quoi'), null);
  assert.equal(L.parseRetryAfter(null), null);
  assert.equal(L.parseRetryAfter(''), null);
  // un 429 respecte Retry-After sans jamais descendre sous le backoff
  assert.equal(L.nextDelayMs({ ok: false, intervalMs: 3000, failures: 1, maxBackoffMs: 30_000, retryAfterMs: 20_000 }), 20_000);
  assert.equal(L.nextDelayMs({ ok: false, intervalMs: 3000, failures: 3, maxBackoffMs: 30_000, retryAfterMs: 2000 }), 24_000);
});

test('jamais deux requêtes simultanées, jamais hors état actif', () => {
  assert.equal(L.canStartRequest({ active: true, inflight: false, routeWants: true }), true);
  assert.equal(L.canStartRequest({ active: true, inflight: true, routeWants: true }), false);
  assert.equal(L.canStartRequest({ active: false, inflight: false, routeWants: true }), false);
  assert.equal(L.canStartRequest({ active: true, inflight: false, routeWants: false }), false);
  // réponse lente : la prochaine requête repart APRÈS la réponse (tick sauté), avec un écart minimal
  assert.equal(L.nextDelayMs({ ok: true, intervalMs: 3000, elapsedMs: 5000, maxBackoffMs: 30_000 }), L.MIN_GAP_MS);
  assert.equal(L.isFatalStatus(401), true);
  assert.equal(L.isFatalStatus(429), false);
});

test('pages concernées : sondage social seulement sur l’accueil et les réseaux', () => {
  assert.deepEqual(L.routeNeeds('overview'), { social: true });
  assert.deepEqual(L.routeNeeds('analytics'), { social: false });
  assert.deepEqual(L.routeNeeds('social/instagram'), { social: true });
  assert.deepEqual(L.routeNeeds('social'), { social: true });
  assert.deepEqual(L.routeNeeds('settings'), { social: false });
  assert.deepEqual(L.routeNeeds(null), { social: false });
});

test('détection de nouveauté : updatedAt / heavyUpdatedAt / blocs en chargement / en-têtes X-Data-*', () => {
  const a = { updatedAt: '2026-10-01T10:00:00Z', heavyUpdatedAt: '2026-10-01T09:50:00Z', loading: [], stale: false, refreshing: false };
  const tok = (d, h) => ({ token: L.dataToken(d, h), data: d });
  assert.equal(L.hasNewData(tok(a), tok({ ...a, refreshing: true, stale: true })), false, 'drapeaux seuls : rien de nouveau');
  assert.equal(L.hasNewData(tok(a), tok({ ...a, updatedAt: '2026-10-01T10:01:00Z' })), true);
  assert.equal(L.hasNewData(tok(a), tok({ ...a, heavyUpdatedAt: '2026-10-01T10:05:00Z' })), true);
  assert.equal(L.hasNewData(tok({ ...a, loading: ['audience'] }), tok({ ...a, loading: [] })), true, 'un bloc est arrivé');
  assert.equal(L.hasNewData(null, tok(a)), true);
  // /api/posts : tableau nu, fraîcheur dans les en-têtes
  const h = (u, l) => ({ 'X-Data-Updated-At': u, ...(l ? { 'X-Data-Loading': l } : {}) });
  assert.equal(L.dataToken([{ id: 1 }], h('2026-10-01T10:00:00Z')), '2026-10-01T10:00:00Z||');
  assert.equal(L.hasNewData(tok([{ id: 1 }], h('2026-10-01T10:00:00Z')), tok([{ id: 1 }, { id: 2 }], h('2026-10-01T10:00:00Z'))), false, 'même jeton : pas de nouveauté');
  assert.equal(L.hasNewData(tok([{ id: 1 }], h('2026-10-01T10:00:00Z')), tok([{ id: 1 }], h('2026-10-01T10:02:00Z'))), true);
  assert.equal(L.dataToken([], { get: (n) => (n === 'X-Data-Loading' ? 'a,b' : null) }), '||a,b', 'objet Headers : lecture par get()');
  // sans jeton : comparaison du contenu
  assert.equal(L.dataToken({ x: 1 }), null);
  assert.equal(L.hasNewData(tok({ x: 1 }), tok({ x: 1 })), false);
  assert.equal(L.hasNewData(tok({ x: 1 }), tok({ x: 2 })), true);
  assert.equal(L.isLoading({ loading: ['post_insights'] }), true);
  assert.equal(L.isLoading({ loading: [] }), false);
  assert.equal(L.isLoading([], { get: () => 'tiktok:thumbnails' }), true);
  assert.equal(L.blockLoading({ loading: ['audience'] }, 'audience'), true);
  assert.equal(L.blockLoading({ loading: ['instagram:audience'] }, 'audience', 'instagram'), true);
  assert.equal(L.blockLoading({ loading: ['instagram:audience'] }, 'audience', 'tiktok'), false);
  assert.equal(L.blockLoading(null, 'audience'), false);
});

test('report du re-rendu : dialogue, focus, sélection, défilement et interaction récents', () => {
  const calm = { dialogOpen: false, focusInControl: false, hasSelection: false, lastScrollAt: T0 - 10_000, lastSelectionAt: T0 - 10_000, now: T0 };
  assert.deepEqual(L.shouldDeferRender(calm), { defer: false, reason: null });
  assert.deepEqual(L.shouldDeferRender({ ...calm, dialogOpen: true }), { defer: true, reason: 'dialog' });
  assert.deepEqual(L.shouldDeferRender({ ...calm, focusInControl: true }), { defer: true, reason: 'focus' });
  assert.deepEqual(L.shouldDeferRender({ ...calm, hasSelection: true }), { defer: true, reason: 'selection' });
  assert.deepEqual(L.shouldDeferRender({ ...calm, lastScrollAt: T0 - 2999 }), { defer: true, reason: 'scroll' });
  assert.equal(L.shouldDeferRender({ ...calm, lastScrollAt: T0 - 3000 }).defer, false);
  assert.deepEqual(L.shouldDeferRender({ ...calm, lastSelectionAt: T0 - 1000 }), { defer: true, reason: 'selection' });
  // après plus de 30 s de report : proposition « Nouvelles données disponibles — Actualiser »
  assert.equal(L.shouldOfferRefresh(null, T0), false);
  assert.equal(L.shouldOfferRefresh(T0 - 30_000, T0), false);
  assert.equal(L.shouldOfferRefresh(T0 - 30_001, T0), true);
});

test('focus : champ, sélecteur, tableau et filtres = interaction en cours ; bouton isolé = non', () => {
  assert.equal(L.isControlFocus(null), false);
  assert.equal(L.isControlFocus({ tag: 'INPUT', type: 'search' }), true);
  assert.equal(L.isControlFocus({ tag: 'input', type: 'checkbox' }), true);
  assert.equal(L.isControlFocus({ tag: 'SELECT' }), true);
  assert.equal(L.isControlFocus({ tag: 'TEXTAREA' }), true);
  assert.equal(L.isControlFocus({ tag: 'DIV', contentEditable: true }), true);
  assert.equal(L.isControlFocus({ tag: 'BUTTON', inTable: true }), true);
  assert.equal(L.isControlFocus({ tag: 'BUTTON', inFilters: true }), true);
  assert.equal(L.isControlFocus({ tag: 'BUTTON' }), false);
  assert.equal(L.isControlFocus({ tag: 'A' }), false);
});

test('indicateur : textes, icônes de pause, âge de la DONNÉE, cache, hors ligne', () => {
  const now = T0;
  assert.equal(L.ageText(4000), '4 s');
  assert.equal(L.ageText(59_400), '59 s');
  assert.equal(L.ageText(125_000), '2 min');
  assert.equal(L.ageText(2 * 3600_000), '2 h');
  assert.equal(L.ageText(3 * 86_400_000), '3 j');
  assert.deepEqual(L.indicatorModel({ state: 'live', dataAt: now - 4000, now }), { kind: 'live', text: 'En direct · mis à jour il y a 4 s', action: null });
  assert.equal(L.indicatorModel({ state: 'live', dataAt: now - 4000, now, refreshing: true }).text, 'Actualisation…');
  assert.deepEqual(L.indicatorModel({ state: 'hidden', now }), { kind: 'paused', text: 'En pause — onglet masqué', action: 'resume' });
  assert.deepEqual(L.indicatorModel({ state: 'idle', now }), { kind: 'paused', text: 'En pause (inactif)', action: 'resume' });
  assert.deepEqual(L.indicatorModel({ state: 'offline', now }), { kind: 'offline', text: 'Hors ligne', action: null });
  assert.equal(L.indicatorModel({ state: 'disabled', now }).action, 'enable');
  assert.equal(L.indicatorModel({ state: 'signed_out', now }).kind, 'none');
  const cache = L.indicatorModel({ state: 'live', dataAt: now - 7 * 60_000, now });
  assert.equal(cache.kind, 'cache');
  assert.equal(cache.text, 'Données en cache (plus de 7 min)');
  assert.deepEqual(L.indicatorModel({ state: 'live', dataAt: now - 1000, now, stale: true }), { kind: 'cache', text: 'Données en cache', action: null });
  assert.equal(L.indicatorModel({ state: 'live', dataAt: now - 90_000, now, stale: true }).text, 'Données en cache (plus de 1 min)');
  assert.equal(L.indicatorModel({ state: 'live', dataAt: now - 1000, now, failing: true }).kind, 'retry');
  assert.equal(L.indicatorModel({ state: 'live', now, hasLiveRoute: false }).text, 'En direct');
  assert.equal(L.indicatorModel({ state: 'live', dataAt: null, now }).text, 'En direct');
  // les textes d'état ne contiennent jamais la couleur comme seul porteur : tous ont un libellé
  for (const s of ['live', 'hidden', 'idle', 'offline', 'disabled']) assert.ok(L.indicatorModel({ state: s, now, dataAt: now }).text.length > 3);
});
