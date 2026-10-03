/* Formats français centralisés. Convention : tout nombre / date / durée affiché passe par ce module.
   Espaces : séparateur de milliers = espace fine insécable (U+202F, produit par Intl fr-FR) ; « 5,4 % » = espace fine insécable avant %.
   Exemples :
     number(12345)        → "12 345"
     numberCard(12345)    → "12,3 k"   (compact k/M au-delà de 10 000 ; en deçà, nombre entier)
     pct(5.43)            → "5,4 %"    (une décimale)
     signedPct(-2.1)      → "−2,1 %"   (signe typographique, jamais de « -2.1% »)
     fmtDate(d)           → "1 oct. 2026"
     fmtDateTime(d)       → "1 oct. 2026 à 14:05"
     relTime(d)           → "il y a 3 h" / "hier" (moins de 7 jours), sinon la date
     fmtDuration(60)      → "1 min 00 s" */

export const NNBSP = ' ';
export const DASH = '—';

const nf = new Intl.NumberFormat('fr-FR');
const nf1 = new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 1 });
const compactF = new Intl.NumberFormat('fr-FR', { notation: 'compact', maximumFractionDigits: 1 });

/** Échappement HTML : toute chaîne venant d'une plateforme ou de l'API passe par ici avant d'entrer dans du HTML. */
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
export const UNAVAILABLE = 'Indisponible';

/** Nombre entier groupé. Valeur inconnue → « Indisponible ». */
export const number = (v) => (isNum(v) ? nf.format(v) : UNAVAILABLE);
/** Compact k/M (toujours). */
export const compact = (v) => (isNum(v) ? compactF.format(v) : UNAVAILABLE);
/** Format des cartes KPI : compact seulement au-delà de 10 000. */
export const numberCard = (v) => (!isNum(v) ? UNAVAILABLE : Math.abs(v) > 10000 ? compactF.format(v) : nf.format(v));
/** Pourcentage (v déjà en %, ex. 5,43 → « 5,4 % »). */
export const pct = (v, d = 1) => (isNum(v) ? `${v.toFixed(d).replace('.', ',').replace('-', '−')}${NNBSP}%` : UNAVAILABLE);
/** Pourcentage signé (+5,4 % / −2,1 %). */
export const signedPct = (v, d = 1) => (isNum(v) ? `${v > 0 ? '+' : ''}${pct(v, d)}` : UNAVAILABLE);
/** Écart en points de pourcentage (taux). */
export const signedPoints = (v, d = 1) => (isNum(v) ? `${v > 0 ? '+' : ''}${v.toFixed(d).replace('.', ',').replace('-', '−')}${NNBSP}pt` : UNAVAILABLE);
/** Entier signé (+12 / −3). */
export const signedNumber = (v) => (isNum(v) ? `${v > 0 ? '+' : v < 0 ? '−' : ''}${nf.format(Math.abs(v))}` : UNAVAILABLE);
/** Octets → Gio (l'agent de monitoring Dokploy mesure en GiB, 1024³). */
export const gio = (v) => (isNum(v) ? `${nf1.format(v / 1024 ** 3)}${NNBSP}Gio` : UNAVAILABLE);

const validDate = (s) => { const d = s instanceof Date ? s : new Date(s); return Number.isNaN(d.getTime()) ? null : d; };
/** « 1 oct. 2026 » */
export function fmtDate(s) {
  const d = validDate(s); if (!d) return UNAVAILABLE;
  return d.toLocaleDateString('fr-FR', { day: 'numeric', month: 'short', year: 'numeric' });
}
/** « 14:05 » */
export function fmtTime(s) {
  const d = validDate(s); if (!d) return UNAVAILABLE;
  return d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
}
/** « 1 oct. 2026 à 14:05 » */
export function fmtDateTime(s) {
  const d = validDate(s); if (!d) return UNAVAILABLE;
  return `${fmtDate(d)} à ${fmtTime(d)}`;
}
/** « 1 oct. » (axes de graphiques, sans année) */
export function fmtDay(s) {
  const d = validDate(String(s).length === 10 ? `${s}T00:00:00` : s); if (!d) return String(s);
  return d.toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' });
}
/** Relatif sous 7 jours (« il y a 3 h », « hier »), sinon date complète. */
export function relTime(s, now = Date.now()) {
  const d = validDate(s); if (!d) return UNAVAILABLE;
  const diff = (now - d.getTime()) / 1000;
  if (diff < 0 || diff >= 86400 * 7) return fmtDate(d);
  const rtf = new Intl.RelativeTimeFormat('fr', { numeric: 'auto' });
  if (diff < 3600) return rtf.format(-Math.max(1, Math.round(diff / 60)), 'minute');
  if (diff < 86400) return rtf.format(-Math.round(diff / 3600), 'hour');
  return rtf.format(-Math.round(diff / 86400), 'day');
}
/** Secondes → « 45 s » / « 1 min 00 s » ; inconnu → null. */
export const fmtDuration = (s) => (!isNum(s) ? null : s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${String(s % 60).padStart(2, '0')} s`);

/** Normalisation de recherche : sans accents, minuscules. */
export const norm = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

/** Nom de pays localisé (code ISO) avec repli. */
export const regionName = (() => {
  try { const dn = new Intl.DisplayNames(['fr'], { type: 'region' }); return (c) => { try { return dn.of(c) || c; } catch (e) { return c; } }; } catch (e) { return (c) => c; }
})();
