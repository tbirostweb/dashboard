/* Instagram : sépare clairement les « insights du compte » (Meta, mesurés par Instagram) des « statistiques calculées sur les publications ».
   Seules les métriques fournies par l'API sont affichées : une métrique absente (null) est omise, jamais remplacée par 0. */
import { esc, isNum, number, numberCard, pct, signedNumber, fmtDay, regionName } from '../core/format.js?v=17';
import { TIMEFRAMES, INTERACTIONS_DEF } from '../core/labels.js?v=17';
import { KpiCard, kpiProps, Fold, ExternalLink, InfoTip, EmptyState, BlockLoading } from '../ui/components.js?v=17';
import { MiniChart, BarList, Facts, LimitsPanel, fmtLong, hasSignal, scrub } from './social-shared.js?v=17';
import { state } from '../core/state.js?v=17';
import { blockLoading } from '../core/live-logic.js?v=17';

const Charts = window.Charts;
const $ = (sel, root = document) => root.querySelector(sel);

const ACCOUNT_TYPES = { BUSINESS: 'Compte professionnel', MEDIA_CREATOR: 'Compte créateur', CREATOR: 'Compte créateur', PERSONAL: 'Compte personnel' };
const METRIC_NAMES = { views: 'vues', reach: 'portée', total_interactions: 'interactions', accounts_engaged: 'comptes ayant interagi', likes: "j'aime", comments: 'commentaires', shares: 'partages', saves: 'enregistrements', reposts: 'republications', replies: 'réponses aux stories', profile_links_taps: 'appuis sur le profil', follows_and_unfollows: 'gains et pertes d’abonnés', views_by_follower: 'vues par type de public', views_by_type: 'vues par type de contenu', reach_by_follow: 'portée par type de public', links_by_button: 'appuis par bouton', profile_visits: 'visites du profil' };
const metricList = (txt) => txt.split(',').map((x) => x.trim().replace(/\.$/, '')).filter(Boolean).map((m) => METRIC_NAMES[m] || m).join(', ');

/** Notes techniques de l'API → langage clair. Les notes inconnues sont conservées telles quelles (échappées à l'affichage). */
export function plainNotes(notes) {
  return (notes || []).map((n) => {
    const t = scrub(n);
    let m = /^Métriques refusées par Meta[^:]*:\s*(.+)$/.exec(t);
    if (m) return `Meta n’a pas fourni certaines mesures sur cette période : ${metricList(m[1])}. Elles sont omises plutôt que remplacées par 0.`;
    m = /^Découpage refusé par Meta[^:]*:\s*(.+)$/.exec(t);
    if (m) return `Meta a refusé le détail de certaines mesures (${metricList(m[1])}) : le total est affiché, pas sa répartition.`;
    m = /^Couverture partielle : (.+)$/.exec(t);
    if (m) return `Collecte partielle : ${m[1]}`;
    return t;
  });
}

function tile(label, k, period, { format = numberCard, hint = '', basis } = {}) {
  if (!k || !isNum(k.value)) return '';
  return KpiCard({ label, value: format(k.value), ...kpiProps(k, { period }), hint, basis });
}
const tiles = (list, label, cols = 4) => {
  const live = list.filter(Boolean);
  return live.length ? `<div class="kpis kpis--ins" style="--cols:${Math.min(cols, live.length)};--cols-md:${Math.min(3, live.length)}" role="group" aria-label="${esc(label)}">${live.join('')}</div>` : '';
};

/** Barre empilée abonnés / non-abonnés (role=img + texte alternatif). */
function followSplit(label, a, b) {
  if (!a || !b || !isNum(a.value) || !isNum(b.value)) return '';
  const total = a.value + b.value; if (!total) return '';
  const pa = a.value / total * 100, pb = 100 - pa;
  return `<div class="split"><h3 class="split__title">${esc(label)}</h3>
    <div class="stack" role="img" aria-label="${esc(`${label} : abonnés ${pct(pa)} (${number(a.value)}), non-abonnés ${pct(pb)} (${number(b.value)}).`)}"><i style="width:${pa.toFixed(2)}%;background:var(--c-instagram)"></i><i style="width:${pb.toFixed(2)}%;background:var(--ink)"></i></div>
    <div class="split__legend" aria-hidden="true"><span><i style="background:var(--c-instagram)"></i>Abonnés <b class="num">${pct(pa)}</b></span><span><i style="background:var(--ink)"></i>Non-abonnés <b class="num">${pct(pb)}</b></span></div></div>`;
}

function profileCard(d) {
  const p = (d && d.profile) || null;
  if (!p) return '';
  const site = p.website ? ExternalLink({ href: /^https?:/i.test(p.website) ? p.website : `https://${p.website}`, label: p.website.replace(/^https?:\/\//i, '').slice(0, 60) }) : null;
  const facts = Facts([
    ['Type de compte', p.accountType ? esc(ACCOUNT_TYPES[p.accountType] || p.accountType) : null],
    ['Abonnés', isNum(p.followersCount) ? number(p.followersCount) : null], ['Abonnements', isNum(p.followsCount) ? number(p.followsCount) : null],
    ['Publications', isNum(p.mediaCount) ? number(p.mediaCount) : null], ['Site web', site]
  ]);
  const bio = p.biography ? `<p class="bio">${esc(p.biography)}</p>` : '';
  if (!facts && !bio) return '';
  return Fold({ id: 'ig-profile', title: 'Profil du compte', sub: 'Tel que publié sur Instagram', body: bio + facts });
}

function reelsBlock(d) {
  const r = d && d.reels;
  if (!r || !isNum(r.count) || r.count <= 0) return '';
  const body = `<div class="kpis kpis--ins" style="--cols:3;--cols-md:3" role="group" aria-label="Reels">
    ${isNum(r.avgWatchTimeSeconds) ? KpiCard({ label: 'Durée moyenne de visionnage', value: fmtLong(r.avgWatchTimeSeconds), deltaReason: 'Moyenne pondérée par les vues.' }) : ''}
    ${isNum(r.totalWatchTimeSeconds) ? KpiCard({ label: 'Temps de visionnage total', value: fmtLong(r.totalWatchTimeSeconds), deltaReason: 'Cumul des Reels mesurés.' }) : ''}
    ${isNum(r.skipRate) ? KpiCard({ label: 'Taux de saut', value: pct(r.skipRate), deltaReason: 'Part de lecteurs ayant quitté le Reel très tôt, valeur Meta.' }) : ''}</div>`;
  return Fold({ id: 'ig-reels', title: 'Reels', sub: `${number(r.count)} Reel${r.count > 1 ? 's' : ''} mesuré${r.count > 1 ? 's' : ''} sur la période`, body });
}

function audienceBlock(a) {
  if (!a || a.status === 'unavailable') return '';
  if (a.status === 'below_threshold') {
    return `<h3 class="split__title">Audience</h3>${EmptyState({ title: 'Audience non disponible', cause: `Meta ne fournit l’âge, le genre, les pays, les villes et les heures d’activité qu’à partir de ${number(a.threshold || 100)} abonnés${isNum(a.followersCount) ? ` ; ce compte en compte ${number(a.followersCount)}` : ''}.` })}`;
  }
  const groups = [a.followers && ['followers', 'Abonnés'], a.engaged && ['engaged', 'Audience engagée']].filter(Boolean);
  const tabs = groups.length > 1 ? `<div class="seg seg--sm" role="group" aria-label="Population affichée">${groups.map(([key, l], i) => `<button type="button" data-aud="${key}" aria-pressed="${i === 0}">${l}</button>`).join('')}</div>` : '';
  const online = Array.isArray(a.onlineHours) && a.onlineHours.some((x) => isNum(x) && x > 0);
  if (!groups.length && !online) return '';
  const peak = online ? a.onlineHours.indexOf(Math.max(...a.onlineHours)) : 0;
  return `<div class="aud"><div class="aud__head"><h3 class="split__title">Audience</h3>${tabs}</div><p class="muted" id="aud-sub"></p><div class="grid grid-2-eq" id="aud-charts"></div>
    ${online ? MiniChart({ id: 'aud-online', title: 'Heures d’activité des abonnés (moyenne, heures fournies par Meta)', summary: `Abonnés en ligne par heure. Pic à ${peak} h avec ${number(a.onlineHours[peak])} abonnés en moyenne.`, columns: ['Heure', 'Abonnés en ligne'], rows: a.onlineHours.map((v, h) => [`${String(h).padStart(2, '0')} h`, isNum(v) ? number(v) : 'n.d.']), height: 'sm' }) : ''}</div>`;
}

function audienceCharts(a, announce) {
  if (!a || a.status !== 'ok') return;
  const t = Charts.theme(), c = t.platform.instagram, box = $('#aud-charts'); if (!box) return;
  let charts = [];
  const draw = (key) => {
    const g = a[key]; if (!g) return;
    state.ui.aud = key;
    document.querySelectorAll('[data-aud]').forEach((x) => x.setAttribute('aria-pressed', String(x.dataset.aud === key)));
    charts.forEach((x) => Charts.destroy(x)); charts = [];
    const who = key === 'engaged' ? 'audience engagée' : 'abonnés';
    $('#aud-sub').textContent = `Top 45 fourni par Meta · ${who}${g.timeframe ? ` · ${TIMEFRAMES[g.timeframe] || g.timeframe}` : ''}`;
    const country = (g.country || []).map((x) => ({ ...x, label: regionName(x.key) }));
    const city = (g.city || []).map((x) => ({ ...x, label: String(x.label || x.key) }));
    const facets = [['aud-age', "Tranches d'âge", g.age, false], ['aud-gender', 'Genre', g.gender, true], ['aud-country', 'Principaux pays', country, false], ['aud-city', 'Principales villes', city, false]].filter((f) => f[2] && f[2].length);
    const gColors = [c, t.ink, t.soft];
    box.innerHTML = facets.map(([id, h, items]) => MiniChart({ id, title: h, height: 'sm', summary: `${h} (${who}) : ${items.slice(0, 8).map((x) => `${x.label} ${number(x.value)}`).join(', ')}.`, columns: [h, who === 'abonnés' ? 'Abonnés' : 'Comptes'], rows: items.map((x) => [x.label, number(x.value)]) })).join('');
    const short = (s) => (s.length > 22 ? `${s.slice(0, 21)}…` : s);
    facets.forEach(([id, , items, round]) => {
      const el = $(`#${id}`); if (!el) return;
      if (round) charts.push(Charts.doughnut(el, { labels: items.map((x) => x.label), data: items.map((x) => x.value), colors: items.map((_, i) => gColors[i % 3]) }));
      else if (id === 'aud-age') charts.push(Charts.bars(el, { labels: items.map((x) => x.label), series: [{ label: who, data: items.map((x) => x.value), color: c }] }));
      else charts.push(Charts.bars(el, { labels: items.slice(0, 10).map((x) => short(id === 'aud-city' ? x.label.split(',')[0] : x.label)), horizontal: true, series: [{ label: who, data: items.slice(0, 10).map((x) => x.value), color: id === 'aud-city' ? t.ink : c }] }));
    });
  };
  draw(state.ui.aud && a[state.ui.aud] ? state.ui.aud : a.followers ? 'followers' : 'engaged');
  document.querySelectorAll('[data-aud]').forEach((b) => b.addEventListener('click', () => {
    document.querySelectorAll('[data-aud]').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
    draw(b.dataset.aud); announce(`Audience : ${b.textContent}.`);
  }));
  if ($('#aud-online')) Charts.bars($('#aud-online'), { labels: a.onlineHours.map((_, h) => `${String(h).padStart(2, '0')}h`), series: [{ label: 'Abonnés en ligne', data: a.onlineHours, color: c }] });
}

export function instagramSections({ stats, ins, posts, period, announce }) {
  const d = stats.details || {};
  const parts = [], limits = [];
  parts.push(profileCard(d), reelsBlock(d));
  let drawIns = () => {};
  if (ins && ins.error) {
    limits.push(`Les insights du compte (Meta) sont indisponibles : ${scrub(ins.error.message || 'erreur inconnue')}`);
  } else if (ins) {
    const v = ins.views || {}, it = ins.interactions || {}, pr = ins.profile || {};
    const views = tiles([tile('Vues', v.total, period, { hint: 'Affichages de vos contenus' }), tile('Spectateurs', v.viewers, period, { hint: 'Comptes uniques touchés' })], 'Vues', 2)
      + followSplit('Vues : abonnés / non-abonnés', v.followers, v.nonFollowers)
      + followSplit('Spectateurs : abonnés / non-abonnés', v.viewersFollowers, v.viewersNonFollowers)
      + BarList({ title: 'Vues par type de contenu', items: v.byContentType, color: 'var(--c-instagram)' });
    const inter = tiles([tile('Interactions', it.total, period, { hint: INTERACTIONS_DEF }), tile('Comptes ayant interagi', it.engagedAccounts, period)], 'Interactions', 2)
      + tiles([tile("J'aime", it.likes, period), tile('Enregistrements', it.saves, period), tile('Commentaires', it.comments, period), tile('Partages', it.shares, period), tile('Republications', it.reposts, period), tile('Réponses aux stories', it.replies, period)], 'Détail des interactions', 3);
    const prof = tiles([tile('Appuis sur les boutons du profil', pr.linkTaps, period, { hint: 'Adresse, appel, e-mail, SMS, réservation' }), tile("Appuis sur l'adresse", pr.addressTaps, period)], 'Clics du profil', 2)
      + BarList({ title: 'Appuis par bouton du profil', items: pr.byButton, color: 'var(--c-instagram)' });
    const gains = tiles([tile('Gain net d’abonnés', pr.netFollowers, period, { format: signedNumber, hint: 'Abonnements moins désabonnements' }), tile('Nouveaux abonnés', pr.follows, period), tile('Désabonnements', pr.unfollows, period)], 'Abonnés gagnés et perdus', 3);
    const reach = ins.series && hasSignal(ins.series.reach) ? MiniChart({ id: 'ins-reach', title: 'Portée quotidienne (comptes uniques par jour)', height: 'mini', summary: `Portée quotidienne sur ${period} jours : maximum ${number(Math.max(...ins.series.reach.filter(isNum)))}.`, columns: ['Date', 'Portée'], rows: ins.series.dates.map((x, i) => [fmtDay(x), isNum(ins.series.reach[i]) ? number(ins.series.reach[i]) : 'n.d.']) }) : '';
    const foll = ins.series && hasSignal(ins.series.newFollowers.map((x) => (isNum(x) ? Math.abs(x) : x))) ? MiniChart({ id: 'ins-follows', title: 'Gain net quotidien d’abonnés', height: 'mini', summary: `Gain net quotidien d'abonnés sur ${period} jours, total ${signedNumber(ins.series.newFollowers.filter(isNum).reduce((s, x) => s + x, 0))}.`, columns: ['Date', 'Gain net'], rows: ins.series.dates.map((x, i) => [fmtDay(x), isNum(ins.series.newFollowers[i]) ? signedNumber(ins.series.newFollowers[i]) : 'n.d.']) }) : '';
    const sub = (id, title, html) => (html ? `<div class="ins-block" aria-labelledby="${id}"><h3 class="ins-block__title" id="${id}">${esc(title)}</h3>${html}</div>` : '');
    const body = [sub('ins-v', 'Vues', views + reach), sub('ins-i', 'Interactions', inter), sub('ins-p', 'Visites de profil et clics', prof), sub('ins-g', 'Gains et pertes d’abonnés', gains + foll), sub('ins-a', 'Audience', audienceBlock(ins.audience) || (blockLoading(stats, 'audience') ? BlockLoading({ text: 'Audience : chargement en cours…', lines: 3 }) : ''))].join('');
    parts.push(Fold({ id: 'ig-insights', title: 'Insights du compte (Meta)', sub: `${period} derniers jours · mesurés par Instagram sur l’ensemble du compte`, body: body || EmptyState({ title: 'Aucun insight', cause: 'Meta n’a fourni aucune mesure de compte sur cette période.' }), open: true }));
    limits.push(...plainNotes(ins.notes));
    drawIns = () => {
      if ($('#ins-reach')) Charts.lines($('#ins-reach'), { labels: ins.series.dates, series: [{ label: 'Portée', data: ins.series.reach, platform: 'instagram', fill: true, connect: true }] });
      if ($('#ins-follows')) Charts.bars($('#ins-follows'), { labels: ins.series.dates.map(fmtDay), series: [{ label: 'Gain net', data: ins.series.newFollowers, colors: ins.series.newFollowers.map((x) => (x < 0 ? Charts.theme().gray : Charts.theme().platform.instagram)) }] });
      audienceCharts(ins.audience, announce);
    };
  }
  limits.push(...plainNotes(d.notes), ...plainNotes((stats.source && stats.source.notes) || []));
  limits.push('Les interactions des publications sont rattachées au jour de publication : Instagram ne fournit pas de courbe quotidienne par publication.');
  if (period > 30) limits.push('Meta ne calcule pas les comptes uniques (spectateurs, comptes ayant interagi) sur 90 jours : choisissez 7 ou 30 jours.');
  if (stats.coverage && stats.coverage.truncated === true) limits.push(`Les insights détaillés ne sont lus que pour ${number(stats.coverage.insightsFetchedFor)} des publications les plus récentes.`);
  limits.push("Les adresses d'images des publications expirent : une miniature absente est remplacée par une icône.");
  return { markup: parts.join(''), limits: LimitsPanel(limits), after: drawIns };
}
export { InfoTip };
