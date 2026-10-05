/* Pièces partagées des pages « réseaux sociaux » (Vue d'ensemble, Synthèse, pages plateforme, commentaires).
   Règles : tout texte venant d'une plateforme passe par esc() ; inconnu (null) n'est jamais affiché comme 0 ; aucune donnée inventée. */
import { esc, isNum, number, pct, fmtDate, fmtDateTime, relTime, DASH } from '../core/format.js?v=17';
import { PLATFORMS, PLATFORM_LABELS as LABELS, statusLabel, statusKind } from '../core/labels.js?v=17';
import { StatusBadge, Img, ExternalLink, Legend, EmptyState, AltTable } from '../ui/components.js?v=17';
import { platformBadge } from '../ui/icons.js?v=17';

export const available = (source) => Boolean(source) && ['connected', 'limited'].includes(source.status);
export const hasNumbers = (arr) => Array.isArray(arr) && arr.some((v) => isNum(v));
/** Série réellement exploitable : au moins une mesure strictement positive (tout null ou 0 = « aucune interaction »). */
export const hasSignal = (arr) => Array.isArray(arr) && arr.some((v) => isNum(v) && v > 0);
export const sumKnown = (arr) => (hasNumbers(arr) ? arr.reduce((s, v) => s + (isNum(v) ? v : 0), 0) : null);
export const legendOf = (networks) => Legend(networks.map((p) => ({ key: p, label: LABELS[p] })));

/** Audience de référence d'une publication selon la plateforme (portée Instagram, vues TikTok, impressions LinkedIn). */
export const audienceOf = (p) => (p.platform === 'instagram' ? p.reach : p.platform === 'tiktok' ? p.views : p.platform === 'linkedin' ? p.impressions : null);
export const AUDIENCE_LABEL = { instagram: 'Portée', tiktok: 'Vues', linkedin: 'Impressions' };

export const statusBadgeOf = (status) => StatusBadge({ kind: statusKind(status), label: statusLabel(status) });

/** Remplace les noms de variables d'environnement par une formulation neutre (jamais affichés à l'écran). */
export const scrub = (s) => String(s ?? '')
  .replace(/\s*\([^)]*\b[A-Z]{3,}(?:_[A-Z0-9]+)+\b[^)]*\)/g, '')
  .replace(/\b[A-Z]{3,}(?:_[A-Z0-9]+)+\b/g, 'un paramètre du serveur');

/** Durée longue : 3 h 05 min, 4 min 12 s, 45 s. Inconnu → null. */
export function fmtLong(sec) {
  if (!isNum(sec)) return null;
  const s = Math.round(sec);
  if (s < 60) return `${s} s`;
  if (s < 3600) return `${Math.floor(s / 60)} min ${String(s % 60).padStart(2, '0')} s`;
  return `${Math.floor(s / 3600)} h ${String(Math.floor((s % 3600) / 60)).padStart(2, '0')} min`;
}

/** Dernière synchronisation connue parmi les plateformes (ISO) ou null. */
export function latestSync(sources) {
  const all = PLATFORMS.map((p) => (sources && sources[p] && sources[p].updatedAt) || null).filter(Boolean).sort();
  return all.length ? all[all.length - 1] : null;
}

// ------------------------------------------------------------------ Publications : miniature, lien, taux
export const rateText = (p) => (isNum(p.engagementRate) ? pct(p.engagementRate) : p.platform === 'linkedin' && p.measured === false ? 'Non mesuré' : 'Indisponible');

/** Cellule « Publication » : miniature (repli si l'URL a expiré), titre, type, lien externe. */
export function postCell(p, { size = 48 } = {}) {
  const title = p.title || 'Publication sans titre';
  return `<div class="post-id"><span class="post-id__img">${Img({ src: p.imageUrl, alt: '', size })}</span><span class="post-id__txt"><span class="post-title">${esc(title)}</span><span class="post-meta">${p.type ? `<span class="tag">${esc(p.type)}</span>` : ''}${p.url ? ExternalLink({ href: p.url, label: 'Voir', ariaLabel: `Voir la publication « ${title} »` }) : ''}</span></span></div>`;
}

/** Liste des meilleures publications (miniature, réseau, interactions, taux). */
export function bestPostsList(posts, { max = 5 } = {}) {
  const list = (posts || []).slice(0, max);
  if (!list.length) return EmptyState({ title: 'Aucune publication', cause: 'Aucune publication mesurée sur la période.' });
  return `<ol class="best-posts">${list.map((p) => `<li class="best-post">
    <span class="post-id__img">${Img({ src: p.imageUrl, alt: '', size: 56 })}</span>
    <div class="best-post__body"><span class="post-title">${esc(p.title || 'Publication sans titre')}</span>
      <span class="post-meta">${platformBadge(p.platform)}<span>${esc(fmtDate(p.publishedAt))}</span>${p.url ? ExternalLink({ href: p.url, label: 'Voir', ariaLabel: `Voir la publication « ${p.title || 'sans titre'} »` }) : ''}</span></div>
    <dl class="best-post__stats"><div><dt>Interactions</dt><dd>${isNum(p.interactions) ? number(p.interactions) : DASH}</dd></div><div><dt>Taux</dt><dd>${esc(rateText(p))}</dd></div></dl></li>`).join('')}</ol>`;
}

// ------------------------------------------------------------------ Agrégats calculés côté client (valeurs connues uniquement)
/** Regroupe des publications : nombre, interactions moyennes, audience moyenne, taux pondéré (publications dont l'audience est connue). */
export function groupStats(posts, keyFn) {
  const m = new Map();
  posts.forEach((p) => {
    const k = keyFn(p); if (k === null || k === undefined) return;
    const g = m.get(k) || { key: k, posts: 0, inter: 0, interN: 0, num: 0, base: 0, aud: 0, audN: 0 };
    g.posts += 1;
    if (isNum(p.interactions)) { g.inter += p.interactions; g.interN += 1; }
    const a = audienceOf(p);
    if (isNum(a)) { g.aud += a; g.audN += 1; }
    if (isNum(a) && a > 0 && isNum(p.interactions)) { g.num += p.interactions; g.base += a; }
    m.set(k, g);
  });
  return [...m.values()].map((g) => ({ ...g, rate: g.base > 0 ? g.num / g.base * 100 : null, avgInter: g.interN ? g.inter / g.interN : null, avgAud: g.audN ? g.aud / g.audN : null }));
}

export const DAYS_FR = ['Lundi', 'Mardi', 'Mercredi', 'Jeudi', 'Vendredi', 'Samedi', 'Dimanche'];
/** Grille jour × tranche de 3 h (heure locale du navigateur) : { cells[7][8] : {posts, rate} }. */
export function heatGrid(posts) {
  const cells = Array.from({ length: 7 }, () => Array.from({ length: 8 }, () => ({ posts: 0, num: 0, base: 0 })));
  posts.forEach((p) => {
    const d = new Date(p.publishedAt); if (Number.isNaN(d.getTime())) return;
    const c = cells[(d.getDay() + 6) % 7][Math.floor(d.getHours() / 3)];
    c.posts += 1;
    const a = audienceOf(p);
    if (isNum(a) && a > 0 && isNum(p.interactions)) { c.num += p.interactions; c.base += a; }
  });
  return cells.map((row) => row.map((c) => ({ posts: c.posts, rate: c.base > 0 ? c.num / c.base * 100 : null })));
}
export const slotLabel = (i) => `${String(i * 3).padStart(2, '0')}h–${String(i * 3 + 3).padStart(2, '0')}h`;

export { fmtDateTime, relTime };

// ------------------------------------------------------------------ Petits blocs réutilisables dans les sections repliables

/** Graphique secondaire (sous-titre h3) : résumé accessible + tableau alternatif. Dessiner ensuite dans <canvas id>. */
export function MiniChart({ id, title, summary, columns, rows, height = 'sm', caption }) {
  return `<div class="mini"><h3 class="split__title" id="${esc(id)}-t">${esc(title)}</h3>
    <div class="chart-box chart-box--${esc(height)}"><canvas id="${esc(id)}" role="img" tabindex="0" aria-labelledby="${esc(id)}-t"${summary ? ` aria-describedby="${esc(id)}-s"` : ''}>${esc(summary || title)}</canvas></div>
    ${summary ? `<p class="chart-card__summary" id="${esc(id)}-s">${esc(summary)}</p>` : ''}${rows && rows.length ? AltTable({ caption: caption || title, columns, rows }) : ''}</div>`;
}

/** Liste de barres horizontales (CSS) : items [{label, value}] ; part en % du total affiché. */
export function BarList({ title, items, max = 10, color = 'var(--c-instagram)', format = number, total }) {
  if (!items || !items.length) return '';
  const shown = items.slice(0, max), sum = total ?? (items.reduce((s, x) => s + (isNum(x.value) ? x.value : 0), 0) || 1);
  return `<div class="split"><h3 class="split__title">${esc(title)}</h3><ul class="split-list split-list--named" aria-label="${esc(title)}">${shown.map((x) => `<li><span class="split-list__name" title="${esc(x.label)}">${esc(x.label)}</span><span class="bar" aria-hidden="true"><i style="width:${Math.max(0, Math.min(100, (x.value / sum) * 100)).toFixed(1)}%;background:${color}"></i></span><span class="num">${esc(format(x.value))} <span class="split-list__pct">(${esc(pct(x.value / sum * 100))})</span></span></li>`).join('')}</ul>${items.length > max ? `<p class="muted">+ ${number(items.length - max)} autre${items.length - max > 1 ? 's' : ''} valeur${items.length - max > 1 ? 's' : ''} dans le tableau.</p>` : ''}</div>`;
}

/** Liste « libellé : valeur » (dl) ; les valeurs null sont omises. rows : [label, htmlDeConfiance]. */
export function Facts(rows) {
  const live = rows.filter((r) => r && r[1] !== null && r[1] !== undefined && r[1] !== '');
  return live.length ? `<dl class="facts">${live.map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${v}</dd></div>`).join('')}</dl>` : '';
}

/** Cadre d'information repliable « Limites de cette période ». items : textes bruts (échappés ici). */
export function LimitsPanel(items, { title = 'Limites de cette période', open = false } = {}) {
  const list = [...new Set(items.filter(Boolean))];
  if (!list.length) return '';
  return `<details class="card fold limits"${open ? ' open' : ''}><summary class="fold__sum"><span class="fold__txt"><h2 class="card__title">${esc(title)}</h2><span class="card__sub">${list.length} point${list.length > 1 ? 's' : ''} à connaître pour bien lire les chiffres</span></span></summary><div class="fold__body"><ul class="limits__list">${list.map((t) => `<li>${esc(t)}</li>`).join('')}</ul></div></details>`;
}
