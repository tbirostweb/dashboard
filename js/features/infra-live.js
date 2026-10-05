/* Zone « données en direct » de la page Infrastructure.

   CONTRAT applyLive(payload) — point d'entrée du polling (js/core/live.js, câblé par un autre agent) :
   - La page expose la fonction de deux façons : `export applyLive` du module infrastructure.js (et deployments.js)
     et `result.applyLive` dans l'objet retourné par render(). Elle renvoie true si la page courante a été mise à jour, false sinon
     (page non affichée, payload invalide). Elle ne re-rend JAMAIS la page : mises à jour DOM ciblées, focus / scroll / filtres / tri /
     pagination / dialogues ouverts conservés (les éléments qui ont le focus dans une zone redessinée le retrouvent).
   - payload = le même objet que GET /api/infrastructure, éventuellement PARTIEL (les champs absents gardent leur valeur précédente) :
       status 'connected'|'error'|'not_configured', version, connection {status, reason, message}, capabilities, notes,
       server { status: available|stale|no_data|network|permission|not_configured|incomplete_config|incompatible_response|unsupported|unknown,
                observedAt | sampleAt (ISO), cpuPercent (0-100), ramUsedBytes, ramTotalBytes, storageUsedBytes, storageTotalBytes,
                message, source, monitoringMode, + optionnels : uptimeSeconds, loadAverage [1,5,15] ou load1/load5/load15,
                networkInBytes, networkOutBytes },
       services [] (remplace la liste → compteurs + tableau mis à jour), deployments [] (idem, page Déploiements).
     Règles : null ≠ 0 (inconnu = « Indisponible », sans piste ni barre) ; une mesure d'état autre que `available` n'est jamais affichée comme actuelle.
   - Éléments mis à jour (attribut data-live, tous sous [data-infra-live]) :
       cpu | ram | disk          jauges (anneau + jauge horizontale, valeur, niveau, valeur absolue en Gio)
       api-status                StatusBadge « API Dokploy »
       monitoring-status         StatusBadge « Monitoring du VPS »
       version                   « Dokploy v… »
       measured-at               « Mesure du HH:MM:SS (il y a N s) » (data-observed = ISO ; l'âge est recalculé toutes les 5 s, sans aria-live)
       mode                      source + mode de monitoring
       reason                    motif affiché quand le monitoring n'est pas `available` (server.message)
       facts                     disponibilité / charge / réseau (uniquement si fournis par l'API)
       details                   notes techniques repliées
       counters (services)       [data-live-counters="services"] compteurs En ligne / En erreur / Inactifs / En cours
       announce                  région aria-live="polite" : n'est écrite QUE lors d'un changement significatif
                                 (changement de niveau normal/attention/critique, mesure qui disparaît ou revient, changement d'état du monitoring ou de l'API),
                                 jamais à chaque mesure. */
import { esc, isNum, pct, gio } from '../core/format.js?v=17';
import { MON_LABEL } from '../core/labels.js?v=17';
import { Ring, Meter, meterLevel } from '../ui/components.js?v=17';
import { infraModel, lastInfra, setLastInfra, measuredText, measuredAt, refreshResults, keepFocus, serviceCounters } from './infra-shared.js?v=17';

const LV = { ok: 'normal', warn: 'attention', crit: 'critique' };

export const gaugeHtml = (g) => `<div class="gauge__ring">${Ring({ label: g.label, percent: g.percent, detail: g.detail })}</div><div class="gauge__meter">${Meter({ label: g.label, percent: g.percent, detail: g.detail })}</div>`;

// ---- Faits optionnels (uniquement ce que l'API fournit réellement) ----
const dur = (s) => { const d = Math.floor(s / 86400), h = Math.floor(s % 86400 / 3600), m = Math.floor(s % 3600 / 60); return d ? `${d} j ${h} h` : h ? `${h} h ${String(m).padStart(2, '0')} min` : `${m} min`; };
const dec = (v) => new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 2 }).format(v);
export function factsHtml(m) {
  const s = m.measured, out = [];
  if (isNum(s.uptimeSeconds) && s.uptimeSeconds >= 0) out.push(['Disponibilité', dur(s.uptimeSeconds)]);
  const load = Array.isArray(s.loadAverage) ? s.loadAverage : [s.load1, s.load5, s.load15];
  if (load.length && load.every(isNum)) out.push(['Charge moyenne', `${load.map(dec).join(' · ')} (1 / 5 / 15 min)`]);
  // Débits fournis en mégabits par seconde (décimaux) par /api/infrastructure/live : jamais convertis en octets, étiquetés « Mbit/s ».
  if (isNum(s.networkInMbps) || isNum(s.networkOutMbps)) out.push(['Réseau', `${isNum(s.networkInMbps) ? `↓ ${dec(s.networkInMbps)} Mbit/s` : '↓ Indisponible'} · ${isNum(s.networkOutMbps) ? `↑ ${dec(s.networkOutMbps)} Mbit/s` : '↑ Indisponible'}`]);
  else if (isNum(s.networkInBytes) || isNum(s.networkOutBytes)) out.push(['Réseau', `${isNum(s.networkInBytes) ? `↓ ${gio(s.networkInBytes)}` : '↓ Indisponible'} · ${isNum(s.networkOutBytes) ? `↑ ${gio(s.networkOutBytes)}` : '↑ Indisponible'}`]);
  return out.length ? `<dl class="infra-facts">${out.map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join('')}</dl>` : '';
}

/** Motif visible quand l'état n'est pas « disponible » (c'est une information actionnable, pas un détail technique). */
export const reasonHtml = (d, m) => { // l'échec de connexion est porté par l'alerte (infraBanner), pas répété ici
  const parts = [];
  if (m.server.status !== 'available' && m.server.message) parts.push(m.server.message);
  return parts.map((p) => `<p>${esc(p)}</p>`).join('');
};

export const detailsHtml = (d, m) => {
  const server = m.server;
  const items = [
    server.storageScope === 'root_filesystem' ? 'Stockage du système de fichiers racine (/), pas la totalité des disques du VPS.' : null,
    'Ressources de l’hôte local ; conteneurs et serveurs distants distincts.',
    'Les mesures anciennes ne sont pas affichées comme actuelles.',
    ...(m.failed ? [] : (d.notes || []))
  ].filter(Boolean);
  const hint = server.hint ? `<p class="infra-notes__hint" data-infra-hint>${esc(server.hint)}</p>` : '';
  return `<ul class="infra-notes">${items.map((n) => `<li>${esc(n)}</li>`).join('')}</ul>${hint}<p class="infra-notes__thresholds">Seuils des jauges : moins de 70 % normal, de 70 à 89 % attention, 90 % et plus critique. Un 0 % est une vraie mesure ; une valeur inconnue est indiquée « Indisponible ».</p>`;
};

export const modeText = (m) => [m.sourceLabel, m.modeLabel].filter(Boolean).join(' · ');

const root = () => document.querySelector('[data-infra-live]');
const q = (r, key) => r.querySelector(`[data-live="${key}"]`);
function setHtml(r, key, html) {
  const el = q(r, key); if (!el) return false;
  if (el._h === html) return false;
  el._h = html; el.innerHTML = html; return true;
}

// ---- Âge de la mesure : recalculé sans re-rendu, sans aria-live ----
let ticker = null;
export function startMeasuredTicker() {
  if (ticker) return;
  ticker = setInterval(() => {
    const el = document.querySelector('[data-live="measured-at"][data-observed]');
    if (!el) { clearInterval(ticker); ticker = null; return; }
    const t = measuredText({ observedAt: el.dataset.observed });
    if (el.textContent !== t) el.textContent = t;
  }, 5000);
}

const levelOf = (p) => (isNum(p) ? meterLevel(Math.max(0, Math.min(100, p))) : null);

export function mergeInfra(base, p) {
  const next = { ...base };
  for (const k of ['status', 'version', 'connection', 'capabilities', 'projects', 'notes', 'reason']) if (k in p) next[k] = p[k];
  if (p.server && typeof p.server === 'object') next.server = { ...(base.server || {}), ...p.server };
  if (Array.isArray(p.services)) next.services = p.services;
  if (Array.isArray(p.deployments)) next.deployments = p.deployments;
  return next;
}

/** Applique un payload « en direct » à la page Infrastructure (voir le contrat en tête de fichier). */
export function applyInfraLive(payload) {
  const r = root();
  if (!r || !payload || typeof payload !== 'object' || Array.isArray(payload) || !lastInfra) return false;
  const prev = infraModel(lastInfra);
  const next = mergeInfra(lastInfra, payload);
  setLastInfra(next);
  const m = infraModel(next);
  keepFocus(() => {
    for (const k of ['cpu', 'ram', 'disk']) setHtml(r, k, gaugeHtml(m.gauges[k]));
    setHtml(r, 'api-status', m.connBadge);
    setHtml(r, 'monitoring-status', m.monBadge);
    setHtml(r, 'version', next.version ? `Dokploy ${esc(next.version)}` : 'Version indisponible');
    const at = measuredAt(m.server), meas = q(r, 'measured-at');
    if (meas) { const t = measuredText(m.server); if (meas.textContent !== t) meas.textContent = t; if (at) meas.dataset.observed = at; else delete meas.dataset.observed; }
    setHtml(r, 'mode', esc(modeText(m)));
    setHtml(r, 'reason', reasonHtml(next, m));
    setHtml(r, 'facts', factsHtml(m));
    setHtml(r, 'details', detailsHtml(next, m));
    if (Array.isArray(payload.services)) refreshResults('services');
    else if (payload.status !== undefined || payload.server) { const c = document.querySelector('[data-live-counters="services"]'); if (c) { const html = serviceCounters(next.services || []); if (c._h !== html) { c._h = html; c.innerHTML = html; } } }
  });
  // Annonce vocale mesurée : uniquement les changements significatifs.
  const msgs = [];
  for (const k of ['cpu', 'ram', 'disk']) {
    const a = prev.gauges[k], b = m.gauges[k], la = levelOf(a.percent), lb = levelOf(b.percent);
    if (la === lb) continue;
    if (lb === null) msgs.push(`${b.label} : mesure indisponible.`);
    else if (lb === 'ok' && la !== null) msgs.push(`${b.label} : retour à un niveau normal (${pct(b.percent, 1)}).`);
    else if (lb !== 'ok') msgs.push(`${b.label} : niveau ${LV[lb]} (${pct(b.percent, 1)}).`);
  }
  if (prev.monState !== m.monState) msgs.push(`Monitoring du VPS : ${MON_LABEL[m.monState] || 'état indéterminé'}.`);
  if (prev.connKind !== m.connKind) msgs.push(`API Dokploy : ${m.connKind === 'connected' ? 'connectée' : m.connKind === 'error' ? 'en erreur' : 'non configurée'}.`);
  const live = q(r, 'announce');
  if (live && msgs.length) { live.textContent = ''; setTimeout(() => { live.textContent = msgs.join(' '); }, 30); }
  return true;
}
