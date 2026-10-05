/* Composants réutilisables : fonctions PURES qui retournent du HTML déjà échappé (sauf les paramètres explicitement
   nommés `html`). Aucune donnée venant d'une plateforme n'entre dans du HTML sans passer par esc().
   Conventions : valeur inconnue = « Indisponible » (jamais 0) ; statut = icône + libellé ; delta = flèche + signe + libellé de période.

   Exemples d'usage :
     KpiCard({ label: 'Abonnés', value: numberCard(k.value), ...kpiProps(k) })
     SectionHeader({ title: 'Publications', sub: '30 derniers jours', actions: Toolbar({ period: 30, refresh: 'instagram' }) })
     StatusBadge({ kind: 'warn', label: 'Mesure ancienne' })
     EmptyState({ title: 'Aucune publication', cause: 'Aucune publication sur la période.', action: { label: 'Voir 90 j', data: 'data-period="90"' } })
     ChartCard({ id: 'c1', title: 'Interactions', legend: [{ key: 'instagram', label: 'Instagram' }], summary: '…', tableFallback: seriesTable({ labels, series }) })
     DataTable({ id: 'posts', columns, rows, sort: { key: 'publishedAt', dir: 'desc' }, filters: true, pageSize: 10, csv: { filename: 'publications' } })
*/
import { esc, isNum, number, numberCard, signedPct, signedPoints, fmtTime, fmtDay, norm } from '../core/format.js?v=16';
import { periodVs, PLATFORM_LABELS } from '../core/labels.js?v=16';
import { STATUS_ICONS, ICON } from './icons.js?v=16';

const KINDS = ['ok', 'warn', 'error', 'info', 'neutral', 'pending'];
const kindOf = (k) => (k === 'err' ? 'error' : KINDS.includes(k) ? k : 'neutral');

// ---------------------------------------------------------------- StatusBadge
/** StatusBadge({kind: ok|warn|error|info|neutral|pending, label, icon?}) : icône (par famille, ou `icon` = clé de STATUS_ICONS) + libellé. */
export function StatusBadge({ kind = 'neutral', label = '', icon } = {}) {
  const k = kindOf(kind);
  return `<span class="status status--${k}">${STATUS_ICONS[icon] || STATUS_ICONS[k]}${esc(label)}</span>`;
}

// ---------------------------------------------------------------- Delta / KpiCard
const DEFAULT_REASON = 'Pas de période précédente à comparer.';
/** Delta({delta, unit: 'percent'|'points', label, reason}) : « ↗ +5,4 % vs 30 j précédents » ; delta null → raison brève. */
export function Delta({ delta, unit = 'percent', label = '', reason = '' } = {}) {
  if (!isNum(delta)) return `<span class="delta delta--none"><span class="delta__reason">${esc(reason || DEFAULT_REASON)}</span></span>`;
  const cls = Math.abs(delta) < 0.05 ? 'flat' : delta > 0 ? 'up' : 'down';
  const word = cls === 'up' ? 'hausse' : cls === 'down' ? 'baisse' : 'stable';
  const txt = unit === 'points' ? signedPoints(delta, 1) : signedPct(delta, 1);
  return `<span class="delta delta--${cls}">${ICON[cls]}<span class="sr-only">${word} </span><span class="delta__v">${txt}</span>${label ? `<span class="delta__label">${esc(label)}</span>` : ''}</span>`;
}

/** kpiProps(k, {period, rate}) : convertit un KPI d'API {value, previous, delta, deltaUnit, periodLabel, reason} en props de KpiCard (delta recalculé si absent). */
export function kpiProps(k, { period, rate = false } = {}) {
  if (!k) return { delta: null, deltaReason: 'Donnée indisponible.' };
  let delta = k.delta;
  const unit = k.deltaUnit === 'points' || (k.deltaUnit === undefined && rate) ? 'points' : 'percent';
  if (delta === undefined && isNum(k.value) && isNum(k.previous)) {
    delta = unit === 'points' ? k.value - k.previous : (k.previous ? (k.value - k.previous) / k.previous * 100 : null);
  }
  return { delta: isNum(delta) ? delta : null, deltaUnit: unit, deltaLabel: k.periodLabel || (period ? periodVs(period) : ''), deltaReason: k.reason || '' };
}

/** Sparkline SVG : values = nombres (null = trou). */
export function Spark(values, { label = 'Évolution' } = {}) {
  const v = (values || []).map((x) => (isNum(x) ? x : null));
  const fin = v.filter((x) => x !== null);
  if (fin.length < 2) return '';
  const min = Math.min(...fin), max = Math.max(...fin), span = max - min || 1, n = v.length;
  let d = '', pen = false;
  v.forEach((x, i) => {
    if (x === null) { pen = false; return; }
    d += `${pen ? 'L' : 'M'}${(i / (n - 1) * 100).toFixed(1)} ${(26 - (x - min) / span * 24).toFixed(1)} `; pen = true;
  });
  return `<svg class="spark" viewBox="0 0 100 28" preserveAspectRatio="none" role="img" aria-label="${esc(`${label} : de ${number(fin[0])} à ${number(fin[fin.length - 1])}`)}"><path d="${d.trim()}" fill="none" stroke="currentColor" stroke-width="1.8" vector-effect="non-scaling-stroke" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
}

/**
 * KpiCard({label, value, unit, delta, deltaUnit, deltaLabel, deltaReason, spark, hint, status, basis})
 * value : texte déjà formaté (ou nombre → numberCard) ; null → « Indisponible ».
 * basis : définition / formule (InfoTip). status : props de StatusBadge. spark : tableau de nombres.
 */
export function KpiCard({ label, value, unit, delta = null, deltaUnit = 'percent', deltaLabel = '', deltaReason = '', spark, hint, status, basis } = {}) {
  const none = value === null || value === undefined || value === '';
  const shown = none ? 'Indisponible' : typeof value === 'number' ? numberCard(value) : String(value);
  return `<div class="kpi">
    <div class="kpi__head"><span class="kpi__label">${esc(label)}</span>${basis ? InfoTip({ label: `Définition : ${label}`, text: basis }) : ''}${status ? StatusBadge(status) : ''}</div>
    <span class="kpi__value${none ? ' kpi__value--none' : ''}">${esc(shown)}${unit && !none ? `<span class="kpi__unit">${esc(unit)}</span>` : ''}</span>
    <span class="kpi__delta">${none ? '' : Delta({ delta, unit: deltaUnit, label: deltaLabel, reason: deltaReason })}</span>
    ${spark ? `<span class="kpi__spark">${Spark(spark, { label })}</span>` : ''}
    ${hint ? `<span class="kpi__hint">${esc(hint)}</span>` : ''}
  </div>`;
}

// ---------------------------------------------------------------- SectionHeader / EmptyState
/** SectionHeader({title, sub, actions (html de confiance), level = 2, id}) */
export function SectionHeader({ title, sub, actions, level = 2, id } = {}) {
  return `<div class="section-head"><div><h${level} class="section-head__title"${id ? ` id="${esc(id)}"` : ''}>${esc(title)}</h${level}>${sub ? `<span class="section-head__sub">${esc(sub)}</span>` : ''}</div>${actions ? `<div class="section-head__actions">${actions}</div>` : ''}</div>`;
}

/** EmptyState({title, cause, action}) ; action = html de confiance OU {label, href} OU {label, data: 'data-xxx'}. */
export function EmptyState({ title, cause, action } = {}) {
  let act = '';
  if (typeof action === 'string') act = action;
  else if (action && action.href) act = `<a class="btn btn-ghost" href="${esc(action.href)}">${esc(action.label)}</a>`;
  else if (action && action.label) act = `<button type="button" class="btn btn-ghost" ${action.data || ''}>${esc(action.label)}</button>`;
  return `<div class="empty-state"><strong class="empty-state__title">${esc(title)}</strong>${cause ? `<p class="empty-state__cause">${esc(cause)}</p>` : ''}${act}</div>`;
}

// ---------------------------------------------------------------- Toolbar
/**
 * Toolbar({period, compare, refresh, updatedAt})
 * period : 7|30|90 courant (boutons data-period gérés par le routeur) ; compare : true → « vs N j précédents » ;
 * refresh : plateforme ('instagram'…) ou 'all' (bouton data-refresh → POST /api/platforms/:p/refresh) ; updatedAt : ISO de l'API.
 */
export function Toolbar({ period, compare, refresh, updatedAt } = {}) {
  const seg = period ? `<div class="seg" role="group" aria-label="Période">${[7, 30, 90].map((p) => `<button type="button" data-period="${p}" aria-pressed="${p === period}">${p} j</button>`).join('')}</div>` : '';
  const cmp = period && compare ? `<span class="toolbar__compare">${esc(periodVs(period))}</span>` : '';
  const upd = refresh || updatedAt !== undefined ? `<span class="toolbar__updated">${updatedAt ? `Mis à jour à <time datetime="${esc(updatedAt)}">${esc(fmtTime(updatedAt))}</time>` : 'Dernière mise à jour inconnue'}</span>` : '';
  const btn = refresh ? `<button type="button" class="btn btn-ghost btn-small" data-refresh="${esc(refresh)}">${ICON.refresh}Actualiser<span class="sr-only"> ${refresh === 'all' ? 'les données' : esc(PLATFORM_LABELS[refresh] || refresh)}</span></button>` : '';
  return `<div class="toolbar" role="group" aria-label="Période et actualisation">${seg}${cmp}<span class="toolbar__spacer"></span>${upd}${btn}</div>`;
}

// ---------------------------------------------------------------- Légende / ChartCard
/** Legend([{key?: plateforme, label, color?: couleur CSS, dash?: '6 4'}]) : trait + motif + libellé (pas la couleur seule). */
export function Legend(items = []) {
  return `<ul class="legend">${items.map((i) => {
    const style = i.color ? ` style="color:${esc(i.color)}"` : '';
    return `<li class="${i.key ? `series--${esc(i.key)}` : ''}"${style}><svg width="26" height="8" viewBox="0 0 26 8" aria-hidden="true"><line x1="1" y1="4" x2="25" y2="4" stroke="currentColor" stroke-width="3" stroke-linecap="round"${i.dash ? ` stroke-dasharray="${esc(i.dash)}"` : i.key ? ' class="legend__line"' : ''}/></svg><span>${esc(i.label)}</span></li>`;
  }).join('')}</ul>`;
}

/** seriesTable({labels, series:[{label,data}], format}) → tableFallback pour ChartCard (dates en « 1 oct. »). */
export function seriesTable({ labels, series, format = number, firstColumn = 'Date', caption = '' }) {
  return { caption, columns: [firstColumn, ...series.map((s) => s.label)], rows: labels.map((l, i) => [fmtDay(l), ...series.map((s) => (isNum(s.data[i]) ? format(s.data[i]) : 'n.d.'))]) };
}

/**
 * ChartCard({id, title, sub, legend, summary, tableFallback, height: 'sm'|'md'|'mini', info})
 * Rend la carte + <canvas id>. Dessiner ensuite avec Charts.lines/bars/doughnut(document.getElementById(id), …).
 * summary : phrase de lecture du graphique (visible + lue) ; tableFallback : {columns, rows, caption} repliable.
 */
export function ChartCard({ id, title, sub, legend, summary, tableFallback, height = 'md', info } = {}) {
  const tf = tableFallback && tableFallback.rows && tableFallback.rows.length ? AltTable({ caption: tableFallback.caption || title, columns: tableFallback.columns, rows: tableFallback.rows }) : '';
  return `<section class="card chart-card" aria-labelledby="${esc(id)}-t">
    <div class="card__head"><div><h2 class="card__title" id="${esc(id)}-t">${esc(title)}${info ? InfoTip({ label: `Définition : ${title}`, text: info }) : ''}</h2>${sub ? `<span class="card__sub">${esc(sub)}</span>` : ''}</div>${legend && legend.length ? Legend(legend) : ''}</div>
    <div class="chart-box chart-box--${esc(height)}"><canvas id="${esc(id)}" role="img" tabindex="0" aria-labelledby="${esc(id)}-t"${summary ? ` aria-describedby="${esc(id)}-s"` : ''}>${esc(summary || title)}</canvas></div>
    ${summary ? `<p class="chart-card__summary" id="${esc(id)}-s">${esc(summary)}</p>` : ''}${tf}
  </section>`;
}

/** AltTable({caption, columns, rows}) : tableau alternatif repliable d'un graphique (première colonne = en-tête de ligne, tout est échappé). */
export function AltTable({ caption = '', columns = [], rows = [], label = 'Afficher les données sous forme de tableau' } = {}) {
  return `<details class="chart-table"><summary>${esc(label)}</summary><div class="table-wrap chart-table__scroll"><table class="data"><caption class="sr-only">${esc(caption)}</caption><thead><tr>${columns.map((c, i) => `<th scope="col"${i ? '' : ' class="left"'}>${esc(c)}</th>`).join('')}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c, i) => (i ? `<td>${esc(c)}</td>` : `<th scope="row" class="left">${esc(c)}</th>`)).join('')}</tr>`).join('')}</tbody></table></div></details>`;
}

/** Fold({id, title, sub, body (html de confiance), open, level = 2}) : section repliable (details/summary natifs, clavier et lecteurs d'écran). */
export function Fold({ id, title, sub, body = '', open = false, level = 2 } = {}) {
  return `<details class="card fold" id="${esc(id)}"${open ? ' open' : ''}><summary class="fold__sum"><span class="fold__txt"><h${level} class="card__title">${esc(title)}</h${level}>${sub ? `<span class="card__sub">${esc(sub)}</span>` : ''}</span></summary><div class="fold__body">${body}</div></details>`;
}

// ---------------------------------------------------------------- Counters / Alert / Details / ButtonGroup (3c)
/** Counters({items: [{key, label, value, kind?, unit?, hint?}], label}) : compteurs par état. value null/inconnu → « Indisponible » (jamais 0). Icône + libellé : la couleur ne porte jamais seule. */
export function Counters({ items = [], label = 'Compteurs' } = {}) {
  return `<ul class="counters" aria-label="${esc(label)}">${items.map((i) => {
    const none = i.value === null || i.value === undefined || (typeof i.value === 'number' && !Number.isFinite(i.value));
    const k = kindOf(i.kind);
    return `<li class="counter counter--${k}" data-counter="${esc(i.key || '')}"><span class="counter__label">${i.kind ? `<span class="counter__icon">${STATUS_ICONS[k]}</span>` : ''}${esc(i.label)}${i.hint ? InfoTip({ label: `Définition : ${i.label}`, text: i.hint }) : ''}</span><span class="counter__value${none ? ' counter__value--none' : ''}">${none ? 'Indisponible' : esc(typeof i.value === 'number' ? number(i.value) : i.value)}${!none && i.unit ? `<small>${esc(i.unit)}</small>` : ''}</span></li>`;
  }).join('')}</ul>`;
}

/** Alert({kind: warn|error|info|ok, title, html (de confiance), actions (html de confiance)}) : alerte compacte (role=alert pour error, status sinon). */
export function Alert({ kind = 'info', title = '', html = '', actions = '' } = {}) {
  const k = kindOf(kind);
  return `<div class="alert alert--${k}" role="${k === 'error' ? 'alert' : 'status'}"><span class="alert__icon">${STATUS_ICONS[k]}</span><div class="alert__body">${title ? `<strong>${esc(title)}</strong> ` : ''}${html}</div>${actions ? `<div class="alert__actions">${actions}</div>` : ''}</div>`;
}

/** Details({summary, html (de confiance), open, className, id}) : panneau repliable natif (clavier et lecteurs d'écran gérés par <details>). */
export function Details({ summary = '', html = '', open = false, className = '', id } = {}) {
  return `<details class="dtl ${esc(className)}"${id ? ` id="${esc(id)}"` : ''}${open ? ' open' : ''}><summary class="dtl__sum">${esc(summary)}</summary><div class="dtl__body">${html}</div></details>`;
}

/** ButtonGroup(html, label) : groupe d'actions explicite (role=group). */
export const ButtonGroup = (html, label = 'Actions') => `<div class="btn-group" role="group" aria-label="${esc(label)}">${html}</div>`;

// ---------------------------------------------------------------- Skeleton / BlockLoading / LiveIndicator (phase finale : mode en direct)
const sk = (cls = '', style = '') => `<span class="sk ${cls}" aria-hidden="true"${style ? ` style="${style}"` : ''}></span>`;
/**
 * Skeleton({variant: 'page' | 'infra' | 'table' | 'settings', label}) : squelette de blocs affiché pendant le PREMIER chargement d'une page
 * (remplace l'écran « Chargement des données… »). Mêmes cartes, mêmes grilles que les vrais composants : pas de saut de mise en page.
 */
export function Skeleton({ variant = 'page', label = 'Chargement des données…' } = {}) {
  const kpis = `<div class="kpis kpis--4 sk-kpis">${[1, 2, 3, 4].map(() => `<div class="kpi">${sk('sk--line sk--w40')}${sk('sk--value')}${sk('sk--line sk--w60')}</div>`).join('')}</div>`;
  const card = (h = 'md') => `<div class="card sk-card">${sk('sk--line sk--w30')}${sk(`sk--box sk--${h}`)}</div>`;
  const rows = `<div class="card sk-card">${sk('sk--line sk--w30')}${[1, 2, 3, 4, 5].map(() => sk('sk--row')).join('')}</div>`;
  const gauges = `<div class="card sk-card">${sk('sk--line sk--w30')}<div class="sk-gauges">${[1, 2, 3].map(() => `<div class="sk-gauge">${sk('sk--ring')}${sk('sk--line sk--w50')}</div>`).join('')}</div></div>`;
  const body = variant === 'infra' ? gauges + rows : variant === 'table' ? rows : variant === 'settings' ? rows + rows : kpis + `<div class="grid grid-2-eq">${card()}${card()}</div>` + rows;
  return `<div class="skeleton" role="status" aria-busy="true"><span class="sr-only">${esc(label)}</span>${body}</div>`;
}

/** BlockLoading({text, lines}) : emplacement « Chargement… » d'UN bloc encore en cours côté serveur (remplacé quand le bloc arrive). */
export const BlockLoading = ({ text = 'Chargement…', lines = 2 } = {}) => `<div class="block-loading" data-block-loading><p class="block-loading__text">${ICON.refresh}<span>${esc(text)}</span></p>${Array.from({ length: lines }, (_, i) => sk(`sk--line sk--w${i % 2 ? 60 : 90}`)).join('')}</div>`;

const LIVE_ICON = { live: ICON.live, refreshing: ICON.refresh, retry: STATUS_ICONS.warn, paused: ICON.pause, offline: ICON.offline, cache: STATUS_ICONS.pending, disabled: STATUS_ICONS.neutral };
const LIVE_ACTION = { resume: 'Reprendre', enable: 'Activer' };
/**
 * LiveIndicator({kind, text, action, offerRefresh}) : état du mode en direct dans l'en-tête. Icône + texte, jamais la couleur seule ;
 * le vert reste réservé à la marque. Le texte (âge de la donnée) est mis à jour par js/core/live.js SANS aria-live.
 * action : 'resume' | 'enable' | null ; offerRefresh : nouvelles données reportées depuis plus de 30 s → bouton « Actualiser ».
 */
export function LiveIndicator({ kind = 'live', text = '', action = null, offerRefresh = false } = {}) {
  const k = LIVE_ICON[kind] ? kind : 'live';
  return `<span class="live live--${k}"><span class="live__icon" aria-hidden="true">${LIVE_ICON[k]}</span><span class="live__text" data-live-text>${esc(text)}</span>${action && LIVE_ACTION[action] ? `<button type="button" class="btn btn-ghost btn-small live__btn" data-live-action="${esc(action)}">${LIVE_ACTION[action]}</button>` : ''}${offerRefresh ? '<button type="button" class="btn btn-ghost btn-small live__btn" data-live-apply>Nouvelles données disponibles — Actualiser</button>' : ''}</span>`;
}

// ---------------------------------------------------------------- Meter / Ring
const LEVELS = { ok: 'Normal', warn: 'Attention', crit: 'Critique' };
/** Seuils : < 70 % normal, 70–89 % attention, ≥ 90 % critique. */
export const meterLevel = (p) => (p >= 90 ? 'crit' : p >= 70 ? 'warn' : 'ok');
const RING_C = 2 * Math.PI * 44;

/** Ring({label, percent, detail}) : anneau ; valeur inconnue → « Indisponible » sans piste. 0 % est une vraie valeur. */
export function Ring({ label, percent, detail } = {}) {
  const known = isNum(percent), p = known ? Math.max(0, Math.min(100, percent)) : 0, lv = meterLevel(p);
  const txt = known ? `${percent.toFixed(1).replace('.', ',')} %` : '';
  const ring = known
    ? `<div class="ring ring--${lv}" role="img" aria-label="${esc(`${label} : ${txt}, ${LEVELS[lv].toLowerCase()}`)}"><svg viewBox="0 0 116 116" aria-hidden="true" focusable="false"><circle class="ring__track" cx="58" cy="58" r="44"/><circle class="ring__value" cx="58" cy="58" r="44" stroke-dasharray="${RING_C.toFixed(2)}" stroke-dashoffset="${(RING_C * (1 - p / 100)).toFixed(2)}"${p > 0 ? ' stroke-linecap="round"' : ''}/></svg><span class="ring__text" aria-hidden="true">${percent.toFixed(1).replace('.', ',')}<small>%</small></span></div><span class="meter-level meter-level--${lv}">${LEVELS[lv]}</span>`
    : '<div class="ring-none">Indisponible</div>';
  return `<div class="ring-tile"><span class="ring-tile__label">${esc(label)}</span>${ring}${detail ? `<span class="ring-tile__detail">${esc(detail)}</span>` : ''}</div>`;
}

/** Meter({label, percent, detail}) : jauge horizontale, mêmes seuils que Ring. */
export function Meter({ label, percent, detail } = {}) {
  const known = isNum(percent), p = known ? Math.max(0, Math.min(100, percent)) : 0, lv = meterLevel(p);
  const txt = known ? `${percent.toFixed(1).replace('.', ',')} %` : 'Indisponible';
  return `<div class="meter${known ? ` meter--${lv}` : ' meter--none'}"><div class="meter__head"><span class="meter__label">${esc(label)}</span><span class="meter__value">${esc(txt)}${known ? `<span class="meter-level meter-level--${lv}">${LEVELS[lv]}</span>` : ''}</span></div>${known ? `<div class="meter__track" role="img" aria-label="${esc(`${label} : ${txt}, ${LEVELS[lv].toLowerCase()}`)}"><i style="width:${p.toFixed(1)}%"></i></div>` : ''}${detail ? `<span class="meter__detail">${esc(detail)}</span>` : ''}</div>`;
}

// ---------------------------------------------------------------- InfoTip
let tipSeq = 0;
/** InfoTip({label, text}) : définition accessible au clavier (bouton + aria-describedby ; Échap la ferme). */
export function InfoTip({ label = 'Définition', text = '' } = {}) {
  const id = `tip-${++tipSeq}`;
  return `<span class="infotip"><button type="button" class="infotip__btn" aria-label="${esc(label)}" aria-describedby="${id}">${ICON.info}</button><span class="infotip__bubble" role="tooltip" id="${id}">${esc(text)}</span></span>`;
}

// ---------------------------------------------------------------- ExternalLink / Img
const httpsOnly = (u) => { try { const x = new URL(u); return x.protocol === 'https:' && !x.username && !x.password ? x.href : null; } catch (e) { return null; } };
/** ExternalLink({href, label, className}) : https uniquement, noopener noreferrer, « ouvre dans un nouvel onglet ». URL invalide → texte seul. */
export function ExternalLink({ href, label, className = 'text-link', ariaLabel } = {}) {
  const u = httpsOnly(href);
  if (!u) return `<span>${esc(label)}</span>`;
  return `<a class="${esc(className)}" href="${esc(u)}" target="_blank" rel="noopener noreferrer" title="${esc(label)} (ouvre dans un nouvel onglet)"${ariaLabel ? ` aria-label="${esc(ariaLabel)} (ouvre dans un nouvel onglet)"` : ''}>${esc(label)}${ICON.external}<span class="sr-only"> (ouvre dans un nouvel onglet)</span></a>`;
}

const imgFallback = (alt, size, shape) => `<span class="img img--${shape} img--fallback" style="--img:${Number(size) || 40}px"${alt ? ` role="img" aria-label="${esc(alt)}"` : ' aria-hidden="true"'}>${ICON.image}</span>`;
/** Img({src, alt, size, shape: 'round'|'square'}) : les URL d'image expirent → repli neutre sur erreur (gestionnaire global). */
export function Img({ src, alt = '', size = 40, shape = 'square' } = {}) {
  const u = httpsOnly(src);
  if (!u) return imgFallback(alt, size, shape);
  return `<img class="img img--${shape}" data-img style="--img:${Number(size) || 40}px" src="${esc(u)}" alt="${esc(alt)}" width="${Number(size) || 40}" height="${Number(size) || 40}" loading="lazy" decoding="async" referrerpolicy="no-referrer">`;
}

// ---------------------------------------------------------------- Tabs / Breadcrumb
/** Tabs({items: [{id, label, href}], current, label}) : tablist ARIA ; flèches/Début/Fin déplacent le focus, Entrée active. */
export function Tabs({ items, current, label = 'Sections' } = {}) {
  return `<div class="tabs" role="tablist" aria-label="${esc(label)}" data-tabs>${items.map((t) => {
    const sel = t.id === current;
    return `<a role="tab" id="tab-${esc(t.id)}" href="${esc(t.href)}" aria-selected="${sel}" aria-controls="tabpanel" tabindex="${sel ? 0 : -1}"${sel ? ' aria-current="page"' : ''}>${t.icon || ''}${esc(t.label)}</a>`;
  }).join('')}</div>`;
}
/** TabPanel(currentId, html) : enveloppe le contenu associé à l'onglet courant. */
export const TabPanel = (currentId, html) => `<div role="tabpanel" id="tabpanel" aria-labelledby="tab-${esc(currentId)}" tabindex="-1">${html}</div>`;
/** Breadcrumb([{label, href?}]) : le dernier élément est la page courante. */
export function Breadcrumb(items = []) {
  return `<nav class="breadcrumb" aria-label="Fil d’Ariane"><ol>${items.map((it, i) => (i === items.length - 1 || !it.href ? `<li><span aria-current="page">${esc(it.label)}</span></li>` : `<li><a href="${esc(it.href)}">${esc(it.label)}</a></li>`)).join('')}</ol></nav>`;
}

// ---------------------------------------------------------------- DataTable
const tables = new Map();
/** Tri mémorisé par identifiant de tableau (survit aux rendus et aux navigations ; non effacé par resetDataTables). */
const sortMemory = new Map();
/** À appeler à chaque changement de page : libère les états de tableaux. */
let restoreStates = null;
/** À appeler à chaque changement de page. keep: true (mise à jour silencieuse de la MÊME page) : recherche, filtres et page des tableaux sont rendus à la recréation. */
export const resetDataTables = ({ keep = false } = {}) => {
  restoreStates = keep ? new Map([...tables].map(([id, t]) => [id, { q: t.q, sel: { ...t.sel }, page: t.page }])) : null;
  tables.clear();
};
export const clearTableRestore = () => { restoreStates = null; };
const dashCell = '<span aria-hidden="true">—</span><span class="sr-only">non disponible</span>';
const csvSafe = (v) => {
  if (v === null || v === undefined) return '';
  if (typeof v === 'number') return String(v).replace('.', ',');
  const s = String(v).replace(/\r?\n/g, ' ');
  return /^[=+\-@\t]/.test(s) ? `'${s}` : s;
};
const rawOf = (c, row) => (c.value ? c.value(row) : row[c.key]);

function visibleRows(t) {
  const q = norm(t.q).trim();
  let rows = t.rows.filter((r) => Object.entries(t.sel).every(([k, v]) => !v || String(rawOf(t.colByKey[k] || { key: k }, r)) === v)
    && (!q || t.columns.some((c) => norm(c.text ? c.text(r) : rawOf(c, r)).includes(q))));
  const col = t.colByKey[t.sort && t.sort.key];
  if (col) {
    const dir = t.sort.dir === 'asc' ? 1 : -1;
    rows = [...rows].sort((a, b) => {
      const x = rawOf(col, a), y = rawOf(col, b);
      if (x === null || x === undefined) return (y === null || y === undefined) ? 0 : 1;
      if (y === null || y === undefined) return -1;
      return (typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y), 'fr', { numeric: true })) * dir;
    });
  }
  return rows;
}

function tableBody(t) {
  const all = visibleRows(t), pages = Math.max(1, Math.ceil(all.length / t.pageSize));
  t.page = Math.min(Math.max(1, t.page), pages);
  const start = (t.page - 1) * t.pageSize, rows = all.slice(start, start + t.pageSize);
  const th = t.columns.map((c) => {
    const sortable = c.sortable !== false && (c.value || c.key);
    const on = t.sort && t.sort.key === c.key;
    return `<th scope="col" class="${c.numeric ? 'num' : ''}"${on ? ` aria-sort="${t.sort.dir === 'asc' ? 'ascending' : 'descending'}"` : ''}>${sortable ? `<button type="button" data-dt-sort="${esc(c.key)}">${esc(c.label)}<span class="dt__arrow" aria-hidden="true">${on ? (t.sort.dir === 'asc' ? '↑' : '↓') : ''}</span></button>` : esc(c.label)}</th>`;
  }).join('');
  const cell = (c, r) => {
    const raw = rawOf(c, r);
    const inner = !c.render && (raw === null || raw === undefined) ? dashCell : c.render ? c.render(r) : esc(c.format ? c.format(raw) : raw);
    return `<td data-label="${esc(c.label)}" class="${c.numeric ? 'num' : ''}${c.wrap ? ' dt__wide' : ''}">${inner}</td>`;
  };
  const body = rows.length
    ? `<div class="table-wrap"><table class="data dt__table"><caption class="sr-only">${esc(t.caption)}</caption><thead><tr>${th}</tr></thead><tbody>${rows.map((r) => `<tr>${t.columns.map((c) => cell(c, r)).join('')}</tr>`).join('')}</tbody>${t.total ? `<tfoot><tr class="dt__total">${t.columns.map((c, i) => `<td data-label="${esc(c.label)}" class="${c.numeric ? 'num' : ''}">${i === 0 ? esc(t.total.label || 'Total') : t.total.values && t.total.values[c.key] !== undefined ? esc(t.total.values[c.key]) : ''}</td>`).join('')}</tr></tfoot>` : ''}</table></div>`
    : `<div class="dt__empty">${t.empty}</div>`;
  const grand = isNum(t.grand) ? t.grand : t.rows.length;
  const count = all.length ? `${start + 1}–${start + rows.length} sur ${number(all.length)}${all.length !== grand ? ` (filtrés sur ${number(grand)})` : ''}` : 'Aucun résultat';
  const pager = pages > 1 ? `<div class="dt__pager"><button type="button" class="btn btn-ghost btn-small" data-dt-page="prev"${t.page <= 1 ? ' disabled' : ''}>Précédent</button><span>Page ${t.page} sur ${pages}</span><button type="button" class="btn btn-ghost btn-small" data-dt-page="next"${t.page >= pages ? ' disabled' : ''}>Suivant</button></div>` : '';
  return { html: body + pager, count };
}

/**
 * DataTable({id, columns, rows, sort, filters, pageSize = 25, empty, csv, total, caption})
 * columns : [{key, label, numeric?, sortable?, value?(row) → valeur de tri/CSV, render?(row) → HTML échappé, format?(v) → texte, text?(row) → texte filtrable, wrap?}]
 *   cellule null (sans render) = tiret + « non disponible » ; numeric = aligné à droite, chiffres tabulaires.
 * sort : {key, dir: 'asc'|'desc'} ; filters : true (recherche) ou {search: 'placeholder', selects: [{key, label, options?: [[valeur, libellé]]}]} ;
 * grand : nombre total de lignes avant un filtrage externe (affiche « filtrés sur N »). csv : {filename} (export des lignes filtrées et triées ; formules neutralisées par un préfixe ') ; total : {label, values: {clé: texte}}.
 * Sous 760 px le tableau passe en cartes (data-label). Les interactions sont gérées par des écouteurs délégués (installés ici).
 */
export function DataTable({ id, columns, rows, sort, filters, pageSize = 25, empty = 'Aucune donnée sur la période.', csv, total, caption = '', grand = null } = {}) {
  const f = filters === true ? { search: true } : filters || {};
  const mem = sortMemory.get(id);
  const rs = restoreStates && restoreStates.get(id);
  const t = { id, columns, rows, sort: (mem && columns.some((c) => c.key === mem.key) ? mem : sort) || null, grand, q: rs ? rs.q : '', sel: rs ? rs.sel : {}, page: rs ? rs.page : 1, pageSize, empty, csv, total, caption: caption || 'Tableau de données', colByKey: Object.fromEntries(columns.map((c) => [c.key, c])), filters: f };
  tables.set(id, t);
  const b = tableBody(t);
  const selects = (f.selects || []).map((s) => {
    const col = t.colByKey[s.key] || { key: s.key };
    const opts = s.options || [...new Set(rows.map((r) => rawOf(col, r)).filter((v) => v !== null && v !== undefined))].sort().map((v) => [String(v), String(v)]);
    return `<div class="field"><label for="${esc(id)}-${esc(s.key)}">${esc(s.label)}</label><select id="${esc(id)}-${esc(s.key)}" data-dt-select="${esc(s.key)}"><option value="">Tous</option>${opts.map(([v, l]) => `<option value="${esc(v)}"${t.sel[s.key] === v ? ' selected' : ''}>${esc(l)}</option>`).join('')}</select></div>`;
  }).join('');
  const search = f.search ? `<div class="field field--search"><label for="${esc(id)}-q">Rechercher</label><input id="${esc(id)}-q" type="search" data-dt-q value="${esc(t.q)}" placeholder="${esc(typeof f.search === 'string' ? f.search : 'Filtrer le tableau…')}" autocomplete="off"></div>` : '';
  const csvBtn = csv ? `<button type="button" class="btn btn-ghost btn-small" data-dt-csv>${ICON.download}Exporter en CSV</button>` : '';
  const bar = search || selects || csvBtn ? `<div class="dt__bar">${search}${selects}${csvBtn}</div>` : '';
  return `<div class="dt" id="${esc(id)}" data-dt="${esc(id)}">${bar}<p class="dt__count" role="status" aria-live="polite" data-dt-count>${esc(b.count)}</p><div data-dt-body>${b.html}</div></div>`;
}

/** Remplace les lignes d'un tableau existant (rafraîchissement sans reconstruire la barre de filtres). */
export function updateDataTable(id, rows, grand = null) {
  const t = tables.get(id); if (!t) return;
  t.rows = rows; t.grand = grand; redraw(t);
}

function redraw(t, focusSel) {
  const root = document.getElementById(t.id); if (!root) return;
  const b = tableBody(t);
  root.querySelector('[data-dt-body]').innerHTML = b.html;
  root.querySelector('[data-dt-count]').textContent = b.count;
  if (focusSel) { const el = root.querySelector(focusSel); if (el) el.focus(); }
}

function exportCsv(t) {
  const rows = visibleRows(t);
  const line = (cells) => cells.map((v) => `"${csvSafe(v).replace(/"/g, '""')}"`).join(';');
  const text = [line(t.columns.map((c) => c.label)), ...rows.map((r) => line(t.columns.map((c) => (c.csv ? c.csv(r) : rawOf(c, r)))))].join('\r\n');
  const url = URL.createObjectURL(new Blob(['﻿' + text], { type: 'text/csv;charset=utf-8' }));
  const a = Object.assign(document.createElement('a'), { href: url, download: `${(t.csv && t.csv.filename) || t.id}.csv` });
  document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export { csvSafe };

// ---------------------------------------------------------------- Gestionnaires globaux (installés une seule fois)
function placeTip(wrap) {
  const bubble = wrap.querySelector('.infotip__bubble'); if (!bubble) return;
  bubble.style.setProperty('--tip-dx', '0px');
  const r = bubble.getBoundingClientRect(), pad = 8, w = document.documentElement.clientWidth;
  let dx = 0;
  if (r.left < pad) dx = pad - r.left; else if (r.right > w - pad) dx = w - pad - r.right;
  bubble.style.setProperty('--tip-dx', `${Math.round(dx)}px`);
}
const openTip = (wrap) => { wrap.classList.add('is-open'); placeTip(wrap); };
const closeTips = () => document.querySelectorAll('.infotip.is-open').forEach((x) => x.classList.remove('is-open'));

if (!window.__sdComponents) {
  window.__sdComponents = true;
  // Repli des images expirées
  document.addEventListener('error', (e) => {
    const img = e.target;
    if (!(img instanceof HTMLImageElement) || !img.hasAttribute('data-img')) return;
    const size = img.getAttribute('width'), shape = img.classList.contains('img--round') ? 'round' : 'square';
    img.outerHTML = imgFallback(img.alt, size, shape);
  }, true);
  // InfoTip : survol, focus, Échap
  document.addEventListener('mouseover', (e) => { const w = e.target.closest && e.target.closest('.infotip'); if (w) openTip(w); });
  document.addEventListener('mouseout', (e) => { const w = e.target.closest && e.target.closest('.infotip'); if (w && !w.contains(e.relatedTarget) && w !== document.activeElement.closest('.infotip')) w.classList.remove('is-open'); });
  document.addEventListener('focusin', (e) => { const w = e.target.closest && e.target.closest('.infotip'); if (w) openTip(w); });
  document.addEventListener('focusout', (e) => { const w = e.target.closest && e.target.closest('.infotip'); if (w) w.classList.remove('is-open'); });
  document.addEventListener('click', (e) => { const w = e.target.closest && e.target.closest('.infotip'); if (w) openTip(w); else closeTips(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeTips(); });
  // Onglets : flèches, Début, Fin
  document.addEventListener('keydown', (e) => {
    const tab = e.target.closest && e.target.closest('[role="tab"]'); if (!tab) return;
    const tabs = [...tab.closest('[role="tablist"]').querySelectorAll('[role="tab"]')], i = tabs.indexOf(tab);
    const next = { ArrowRight: tabs[(i + 1) % tabs.length], ArrowLeft: tabs[(i - 1 + tabs.length) % tabs.length], Home: tabs[0], End: tabs[tabs.length - 1] }[e.key];
    if (!next) return;
    e.preventDefault(); tabs.forEach((x) => x.setAttribute('tabindex', x === next ? '0' : '-1')); next.focus();
  });
  // DataTable : tri, filtre, pagination, export
  const tableOf = (el) => { const root = el.closest('[data-dt]'); return root && tables.get(root.dataset.dt); };
  document.addEventListener('click', (e) => {
    const s = e.target.closest('[data-dt-sort]');
    if (s) { const t = tableOf(s); if (!t) return; const k = s.dataset.dtSort; t.sort = t.sort && t.sort.key === k ? { key: k, dir: t.sort.dir === 'asc' ? 'desc' : 'asc' } : { key: k, dir: t.colByKey[k].numeric ? 'desc' : 'asc' }; t.page = 1; sortMemory.set(t.id, t.sort); redraw(t, `[data-dt-sort="${k}"]`); return; }
    const p = e.target.closest('[data-dt-page]');
    if (p) { const t = tableOf(p); if (!t) return; t.page += p.dataset.dtPage === 'next' ? 1 : -1; redraw(t, `[data-dt-page="${p.dataset.dtPage}"]:not([disabled])`); return; }
    const c = e.target.closest('[data-dt-csv]');
    if (c) { const t = tableOf(c); if (t) exportCsv(t); }
  });
  document.addEventListener('input', (e) => { const q = e.target.closest('[data-dt-q]'); if (!q) return; const t = tableOf(q); if (!t) return; t.q = q.value; t.page = 1; redraw(t); });
  document.addEventListener('change', (e) => { const s = e.target.closest('[data-dt-select]'); if (!s) return; const t = tableOf(s); if (!t) return; t.sel[s.dataset.dtSelect] = s.value; t.page = 1; redraw(t); });
}
