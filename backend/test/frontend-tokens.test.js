// Tests PURS (sans DOM, sans réseau) de la logique des jetons du frontend : js/core/token-logic.js.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as T from '../../js/core/token-logic.js';

const NOW = Date.parse('2026-10-01T10:00:00Z');
const iso = (ms) => new Date(NOW + ms).toISOString();
const H = 3600_000, D = 86400_000;
const PLATFORMS = ['tiktok', 'instagram', 'linkedin'];
const HEALTHS = ['ok', 'renewing', 'reconnect_soon', 'reconnect_required', 'not_connected', 'pending'];

const token = (over = {}) => ({ kind: 'auto', autoRenew: true, accessExpiresAt: iso(7 * H), refreshExpiresAt: iso(365 * D), lastRenewedAt: iso(-5 * 60_000), lastRenewError: null, health: 'ok', reconnectBy: null, reconnectPath: null, note: '', ...over });
const plat = (p, over = {}, tokenOver = {}) => ({ connected: true, status: 'connected', configured: true, token: token({ reconnectPath: `/api/auth/${p}/login`, ...tokenOver }), ...over });
const ids = (v) => v.actions.map((a) => a.id);

test('badge : un libellé et une famille visuelle par santé (le vert n’est jamais un statut)', () => {
  assert.deepEqual(T.tokenBadge(token()), { health: 'ok', kind: 'ok', label: 'Renouvelé automatiquement' });
  assert.equal(T.tokenBadge(token({ kind: 'manual', autoRenew: false })).label, 'Jeton valide');
  assert.deepEqual(T.tokenBadge(token({ health: 'renewing' })), { health: 'renewing', kind: 'info', label: 'Renouvellement en cours' });
  const soon = T.tokenBadge(token({ health: 'reconnect_soon', reconnectBy: '2027-10-01T00:00:00Z' }));
  assert.equal(soon.kind, 'warn'); assert.match(soon.label, /^Reconnexion à prévoir avant le .*2027/);
  assert.equal(T.tokenBadge(token({ health: 'reconnect_soon', reconnectBy: null })).label, 'Reconnexion à prévoir');
  assert.deepEqual(T.tokenBadge(token({ health: 'reconnect_required' })), { health: 'reconnect_required', kind: 'error', label: 'Reconnexion nécessaire' });
  assert.deepEqual(T.tokenBadge(token({ health: 'pending' })), { health: 'pending', kind: 'pending', label: 'En attente d’approbation' });
  assert.deepEqual(T.tokenBadge(token({ health: 'not_connected' })), { health: 'not_connected', kind: 'neutral', label: 'Non relié' });
  assert.equal(T.tokenBadge(null), null);
  assert.equal(T.tokenBadge({ health: 'inconnu' }), null);
  for (const h of HEALTHS) assert.notEqual(T.tokenBadge(token({ health: h })).kind, 'accent');
});

test('badge des pages plateforme / synthèse : seulement renewing, reconnect_soon, reconnect_required', () => {
  assert.equal(T.attentionBadge(token()), null);
  assert.equal(T.attentionBadge(token({ health: 'not_connected' })), null);
  assert.equal(T.attentionBadge(token({ health: 'pending' })), null);
  assert.equal(T.attentionBadge(null), null);
  for (const h of ['renewing', 'reconnect_soon', 'reconnect_required']) assert.equal(T.attentionBadge(token({ health: h })).health, h);
});

test('actions : ordre fixe, libellés non ambigus, noms de réseau dans aria-label — tous health × réseau (auto)', () => {
  for (const p of PLATFORMS) {
    for (const h of ['ok', 'renewing', 'reconnect_soon', 'reconnect_required']) {
      const v = T.tokenView(p, plat(p, {}, { health: h }), NOW);
      assert.deepEqual(ids(v), ['open', 'refresh', 'renew', 'reconnect', 'disconnect'], `${p}/${h}`);
      const n = T.nameOf(p);
      assert.deepEqual(v.actions.map((a) => a.aria), [`Ouvrir la page ${n}`, `Actualiser les données ${n}`, `Renouveler le jeton ${n}`, `Reconnecter ${n}`, `Déconnecter ${n}`]);
      assert.deepEqual(v.actions.map((a) => a.label), ['Ouvrir la page', 'Actualiser les données', 'Renouveler le jeton', 'Reconnecter', 'Déconnecter']);
      assert.equal(v.actions[0].href, `#/social/${p}`);
      assert.equal(v.actions[0].link, true);
      assert.equal(v.actions[1].title, 'Relit les statistiques du réseau ; ne renouvelle pas le jeton.');
      assert.equal(v.actions[2].disabled === true, h === 'reconnect_required');
      if (h !== 'reconnect_required') assert.equal(v.actions[2].title, `Demande un nouveau jeton à ${n} maintenant ; en temps normal c’est automatique.`);
      assert.equal(v.actions[3].link, true); assert.equal(v.actions[3].href, `/api/auth/${p}/login`);
      assert.equal(v.actions[3].variant, h === 'reconnect_soon' || h === 'reconnect_required' ? 'primary' : 'secondary');
      assert.equal(v.actions[4].variant, 'danger');
      assert.ok(v.actions.filter((a) => a.variant === 'primary').length <= 1);
    }
  }
});

test('actions : jeton manuel (LinkedIn) = pas de « Renouveler », mais « Reconnecter » présent', () => {
  const v = T.tokenView('linkedin', plat('linkedin', {}, { kind: 'manual', autoRenew: false, health: 'reconnect_soon', reconnectBy: iso(10 * D) }), NOW);
  assert.deepEqual(ids(v), ['open', 'refresh', 'reconnect', 'disconnect']);
  assert.equal(v.actions.find((a) => a.id === 'reconnect').variant, 'primary');
  assert.equal(v.accessLine.label, 'Jeton d’accès'); // pas « renouvelé automatiquement »
  assert.equal(v.renewedLine, null);
  assert.equal(v.refreshLine, null);
  const ok = T.tokenView('linkedin', plat('linkedin', {}, { kind: 'manual', autoRenew: false }), NOW);
  assert.equal(ok.actions.find((a) => a.id === 'reconnect').variant, 'secondary');
});

test('actions : non relié → « Connecter » seul ; en attente (LinkedIn) → aucune action ; identifiants absents → aucune action', () => {
  for (const p of PLATFORMS) {
    const v = T.tokenView(p, { connected: false, status: 'not_connected', configured: true, token: token({ health: 'not_connected' }) }, NOW);
    assert.deepEqual(ids(v), ['connect']); assert.equal(v.actions[0].href, `/api/auth/${p}/login`); assert.equal(v.actions[0].aria, `Connecter ${T.nameOf(p)}`);
    assert.equal(v.connected, false);
    assert.deepEqual(ids(T.tokenView(p, { connected: false, status: 'not_connected' }, NOW)), ['connect']); // sans objet token
  }
  const pend = T.tokenView('linkedin', { connected: false, status: 'pending_approval', token: token({ health: 'pending', kind: 'manual', autoRenew: false }) }, NOW);
  assert.deepEqual(pend.actions, []); assert.match(pend.hint, /validation/);
  const unconf = T.tokenView('tiktok', { connected: false, status: 'not_connected', configured: false }, NOW);
  assert.deepEqual(unconf.actions, []); assert.match(unconf.hint, /Identifiants/);
});

test('reconnectPath : accepté seulement s’il a la forme /api/auth/<ce réseau>/login (jamais une URL externe)', () => {
  assert.equal(T.reconnectHref('tiktok', '/api/auth/tiktok/login'), '/api/auth/tiktok/login');
  assert.equal(T.reconnectHref('tiktok', 'https://evil.example/x'), '/api/auth/tiktok/login');
  assert.equal(T.reconnectHref('tiktok', '/api/auth/instagram/login'), '/api/auth/tiktok/login');
  assert.equal(T.reconnectHref('tiktok', '//evil.example/api/auth/tiktok/login'), '/api/auth/tiktok/login');
  assert.equal(T.reconnectHref('tiktok', null), '/api/auth/tiktok/login');
});

test('colonne Jeton : accès renouvelé automatiquement, dernier renouvellement, erreur et note du backend', () => {
  const v = T.tokenView('tiktok', plat('tiktok', {}, { note: 'Renouvelé tout seul.', lastRenewError: 'Renouvellement indisponible.' }), NOW);
  assert.equal(v.badge.label, 'Renouvelé automatiquement');
  assert.equal(v.note, 'Renouvelé tout seul.');
  assert.equal(v.accessLine.label, 'Jeton d’accès (renouvelé automatiquement)');
  assert.equal(v.refreshLine.label, 'Renouvellement possible jusqu’au');
  assert.equal(v.renewedLine, 'Dernier renouvellement : il y a 5 min');
  assert.equal(v.error, 'Renouvellement indisponible.');
  const never = T.tokenView('tiktok', plat('tiktok', {}, { lastRenewedAt: null }), NOW);
  assert.equal(never.renewedLine, 'Dernier renouvellement : jamais depuis la connexion');
  assert.equal(never.error, null);
});

test('« il y a N min » et compte à rebours', () => {
  assert.equal(T.agoLabel(iso(-20_000), NOW), 'à l’instant');
  assert.equal(T.agoLabel(iso(-60_000), NOW), 'il y a 1 min');
  assert.equal(T.agoLabel(iso(-5 * 60_000), NOW), 'il y a 5 min');
  assert.equal(T.agoLabel(iso(-3 * H), NOW), 'il y a 3 h');
  assert.equal(T.agoLabel(iso(-2 * D), NOW), 'il y a 2 j');
  assert.match(T.agoLabel(iso(-90 * D), NOW), /^le .*2026/);
  assert.equal(T.agoLabel('n’importe quoi', NOW), null);
  assert.equal(T.renewedLabel(null, NOW), 'Dernier renouvellement : jamais depuis la connexion');
  assert.equal(T.countdownText(NOW + 25_000, NOW), '25 s');
  assert.equal(T.countdownText(NOW + 24_100, NOW), '25 s'); // arrondi au-dessus : jamais « 0 s » avant l'échéance
  assert.equal(T.countdownText(NOW + 65_000, NOW), '1 min 05 s');
  assert.equal(T.countdownText(NOW + 20 * 60_000, NOW), '20 min');
  assert.equal(T.countdownText(NOW + 3 * H, NOW), '3 h');
  assert.equal(T.countdownText(NOW - 5000, NOW), '0 s');
});

// ---------------------------------------------------------------- Alertes
test('alerte : seulement reconnect_soon / reconnect_required ; textes exacts', () => {
  const platforms = {
    tiktok: plat('tiktok', {}, { health: 'reconnect_soon', reconnectBy: '2026-10-21T00:00:00Z' }),
    instagram: plat('instagram', {}, { health: 'reconnect_required' }),
    linkedin: plat('linkedin', {}, { health: 'ok', kind: 'manual', autoRenew: false })
  };
  const a = T.connectionAlerts(platforms);
  assert.equal(a.length, 2);
  assert.equal(a[0].platform, 'tiktok'); assert.equal(a[0].kind, 'warn'); assert.match(a[0].text, /^TikTok : reconnexion nécessaire avant le .*2026$/);
  assert.equal(a[0].reconnectPath, '/api/auth/tiktok/login');
  assert.deepEqual({ p: a[1].platform, k: a[1].kind, t: a[1].text }, { p: 'instagram', k: 'error', t: 'Instagram : reconnexion nécessaire maintenant' });
  assert.deepEqual(T.actionableAlerts(a).map((x) => x.platform), ['tiktok', 'instagram']);
});

test('RÈGLE : jamais d’alerte sur accessExpiresAt quand autoRenew est vrai (cas de la capture : TikTok, accès expirant dans 7 h)', () => {
  for (const p of PLATFORMS) for (const delta of [-5 * H, 1 * H, 7 * H, 20 * H]) {
    const x = plat(p, { expiresAt: iso(delta) }, { health: 'ok', accessExpiresAt: iso(delta) });
    assert.deepEqual(T.connectionAlerts({ [p]: x }), [], `${p} ${delta}`);
    for (const h of ['ok', 'renewing']) assert.deepEqual(T.connectionAlerts({ [p]: plat(p, { expiresAt: iso(delta) }, { health: h, accessExpiresAt: iso(delta) }) }), []);
  }
  // L'échéance d'accès ne produit pas non plus de ligne dans la vue (juste une information secondaire libellée)
  const v = T.tokenView('tiktok', plat('tiktok', { expiresAt: iso(7 * H) }, { accessExpiresAt: iso(7 * H) }), NOW);
  assert.equal(v.badge.kind, 'ok'); assert.equal(v.accessLine.auto, true);
  assert.equal(T.attentionBadge(v.badge && plat('tiktok').token), null);
});

test('alerte : LinkedIn en attente = information discrète (niveau « info »), jamais une alerte ; non relié = rien', () => {
  const a = T.connectionAlerts({ linkedin: { connected: false, status: 'pending_approval', token: token({ health: 'pending', kind: 'manual', autoRenew: false }) }, tiktok: { connected: false, status: 'not_connected', token: token({ health: 'not_connected' }) } });
  assert.equal(a.length, 1); assert.equal(a[0].level, 'info'); assert.equal(a[0].kind, 'info'); assert.equal(a[0].text, 'LinkedIn : en attente d’approbation');
  assert.deepEqual(T.actionableAlerts(a), []);
});

test('alerte : ancien serveur sans objet token → seul le statut « expired » compte, jamais expiresAt', () => {
  assert.deepEqual(T.connectionAlerts({ tiktok: { connected: true, status: 'connected', expiresAt: iso(7 * H) } }), []);
  const a = T.connectionAlerts({ tiktok: { connected: true, status: 'expired' } });
  assert.equal(a.length, 1); assert.equal(a[0].kind, 'error');
});

// ---------------------------------------------------------------- États après action
test('renouvellement : succès (annonce avec dates)', () => {
  const o = T.renewOutcome('tiktok', { ok: true, platform: 'tiktok', renewed: true, expiresAt: iso(24 * H), refreshExpiresAt: '2027-10-01T00:00:00Z', renewedAt: iso(0), message: 'x' }, NOW);
  assert.equal(o.ok, true); assert.equal(o.kind, 'ok'); assert.equal(o.lockUntil, null); assert.equal(o.highlightReconnect, false);
  assert.match(o.text, /^Jeton TikTok renouvelé — valable jusqu’au .*2026.*, renouvelable jusqu’au .*2027\.$/);
  const noDates = T.renewOutcome('instagram', { ok: true, renewed: true }, NOW);
  assert.equal(noDates.text, 'Jeton Instagram renouvelé.');
  assert.equal(T.renewOutcome('instagram', { ok: true, renewed: false, message: 'Déjà à jour.' }, NOW).text, 'Déjà à jour.');
});

test('renouvellement : 409 reconnect_required / not_refreshable → message + mise en avant de « Reconnecter »', () => {
  const rr = T.renewOutcome('tiktok', { status: 409, code: 'reconnect_required', message: 'secret ?', reconnectPath: '/api/auth/tiktok/login' }, NOW);
  assert.equal(rr.kind, 'error'); assert.equal(rr.highlightReconnect, true); assert.equal(rr.reconnectPath, '/api/auth/tiktok/login');
  assert.equal(rr.text, 'La connexion à TikTok a expiré ou a été refusée : reconnectez le compte.');
  const nr = T.renewOutcome('linkedin', { status: 409, code: 'not_refreshable', data: { reconnectPath: '/api/auth/linkedin/login' } }, NOW);
  assert.equal(nr.highlightReconnect, true); assert.match(nr.text, /LinkedIn ne peut pas être renouvelé automatiquement : reconnectez le compte/);
  assert.equal(nr.reconnectPath, '/api/auth/linkedin/login');
  const nc = T.renewOutcome('tiktok', { status: 409, code: 'not_connected' }, NOW);
  assert.equal(nc.highlightReconnect, false); assert.equal(nc.text, 'TikTok n’est pas relié.');
  const pa = T.renewOutcome('linkedin', { status: 409, code: 'pending_approval' }, NOW);
  assert.equal(pa.kind, 'info'); assert.match(pa.text, /en attente d’approbation/);
});

test('renouvellement : 409 too_soon (Instagram) → date d’éligibilité et blocage jusque-là', () => {
  const eligibleAt = iso(5 * H);
  const o = T.renewOutcome('instagram', { status: 409, code: 'too_soon', eligibleAt, retryAfter: 18000 }, NOW);
  assert.equal(o.lockUntil, Date.parse(eligibleAt)); assert.equal(o.kind, 'info');
  assert.match(o.text, /^Instagram permet le renouvellement à partir du .*2026.*\.$/);
  const viaData = T.renewOutcome('instagram', { status: 409, code: 'too_soon', data: { eligibleAt } }, NOW);
  assert.equal(viaData.lockUntil, Date.parse(eligibleAt));
  const sansDate = T.renewOutcome('instagram', { status: 409, code: 'too_soon', retryAfter: '3600' }, NOW);
  assert.equal(sansDate.lockUntil, NOW + 300_000); // borné à 5 min par parseRetryAfter
});

test('renouvellement : 429 → blocage jusqu’à Retry-After (secondes ou date HTTP), compte à rebours', () => {
  const o = T.renewOutcome('tiktok', { status: 429, code: 'refresh_too_soon', retryAfter: '25' }, NOW);
  assert.equal(o.lockUntil, NOW + 25_000); assert.equal(o.kind, 'warn');
  assert.equal(o.text, 'Trop de demandes pour TikTok : réessayez dans 25 s.');
  assert.equal(o.lead, 'Trop de demandes pour TikTok : réessayez dans '); assert.equal(o.tail, '.');
  assert.equal(T.renewOutcome('tiktok', { status: 429, code: 'too_many_requests', retryAfter: new Date(NOW + 40_000).toUTCString() }, NOW).lockUntil, NOW + 40_000);
  assert.equal(T.renewOutcome('tiktok', { status: 429, code: 'too_many_requests' }, NOW).lockUntil, NOW + 30_000); // repli sans Retry-After
  assert.equal(T.renewOutcome('tiktok', { status: 429, code: 'refresh_too_soon', data: { retryAfter: 12 } }, NOW).lockUntil, NOW + 12_000);
});

test('renouvellement : 502 et erreurs inconnues → texte neutre, aucun détail technique', () => {
  assert.equal(T.renewOutcome('tiktok', { status: 502, code: 'upstream', message: 'ECONNRESET 10.0.0.1 token=abc' }, NOW).text, 'Le réseau ne répond pas, réessayez.');
  const o = T.renewOutcome('tiktok', { status: 500, code: 'http', message: 'Error: boom at /srv/app.js secret=xyz' }, NOW);
  assert.equal(o.kind, 'error'); assert.doesNotMatch(o.text, /boom|secret|srv/); assert.equal(o.lockUntil, null);
  assert.doesNotMatch(T.renewOutcome('tiktok', { status: 409, code: 'reconnect_required', message: 'access_token=SECRET' }, NOW).text, /SECRET/);
  assert.equal(T.renewOutcome('tiktok', { status: 0, code: 'network' }, NOW).kind, 'error');
});

test('actualisation des données : 200 / budget épuisé / 409 / 429 / autre', () => {
  assert.equal(T.refreshOutcome('tiktok', { ok: true, status: 'refreshed' }, NOW).text, 'Données TikTok actualisées.');
  const b = T.refreshOutcome('instagram', { ok: true, status: 'budget_exhausted', message: 'Budget atteint.' }, NOW);
  assert.equal(b.kind, 'info'); assert.equal(b.text, 'Budget atteint.');
  assert.equal(T.refreshOutcome('tiktok', { status: 409, code: 'not_connected' }, NOW).text, 'TikTok n’est pas relié.');
  assert.match(T.refreshOutcome('tiktok', { status: 409, code: 'token_expired' }, NOW).text, /expiré : reconnectez/);
  const r = T.refreshOutcome('tiktok', { status: 429, code: 'refresh_too_soon', retryAfter: '45' }, NOW);
  assert.equal(r.lockUntil, NOW + 45_000); assert.equal(r.text, 'Actualisation de TikTok possible dans 45 s.');
  assert.equal(T.refreshOutcome('tiktok', { status: 429 }, NOW).lockUntil, NOW + 60_000);
  assert.equal(T.refreshOutcome('tiktok', { status: 502, code: 'upstream' }, NOW).text, 'Le réseau ne répond pas, réessayez.');
  assert.equal(T.refreshOutcome('tiktok', { status: 500, code: 'http', message: 'Error stack' }, NOW).kind, 'error');
});

test('libellés : une seule source, infobulle du renouvellement par réseau', () => {
  assert.equal(T.TOKEN_TEXT.renewTip('TikTok'), 'Demande un nouveau jeton à TikTok maintenant ; en temps normal c’est automatique.');
  assert.equal(T.TOKEN_TEXT.busy, 'En cours…');
  assert.equal(T.nameOf('linkedin'), 'LinkedIn');
});
