/* LinkedIn : page d'attente propre tant que l'accès n'est pas accordé ; une fois connecté, blocs issus de details.blocks
   (chaque bloc : ok | scope_missing | not_available | budget_exhausted + raison). Les facettes d'audience sont des identifiants non résolus :
   aucun libellé n'est deviné. Aucune variable d'environnement n'est affichée (la procédure est dans Paramètres). */
import { esc, isNum, number, pct, fmtDay, fmtDate, fmtDateTime } from '../core/format.js?v=16';
import { STATUS_LABEL } from '../core/labels.js?v=16';
import { KpiCard, Fold, StatusBadge, EmptyState, ExternalLink, AltTable } from '../ui/components.js?v=16';
import { Facts, LimitsPanel, MiniChart, BarList, hasSignal, scrub } from './social-shared.js?v=16';
import { plainNotes } from './platform-instagram.js?v=16';

const Charts = window.Charts;
const $ = (sel, root = document) => root.querySelector(sel);

/** Ce qui s'affichera après accès, avec le scope requis par bloc. */
const FUTURE = [
  ['Organisation', 'Nom, site, description et type de la Page.', 'rw_organization_admin'],
  ['Audience', 'Abonnés, gains organiques et payants, répartition par pays, fonction, ancienneté, secteur.', 'rw_organization_admin'],
  ['Statistiques de la Page', 'Pages vues et visiteurs par jour, sections consultées, appareils, clics.', 'rw_organization_admin'],
  ['Publications', 'Impressions, impressions uniques, clics et taux d’engagement de chaque publication.', 'r_organization_social'],
  ['Réactions', 'Détail des réactions par type (j’aime, bravo…).', 'r_organization_social_feed'],
  ['Commentaires', 'Commentaires des publications (conservés 48 h au maximum).', 'r_organization_social_feed']
];

export function linkedinPending(ps) {
  return `<section class="card state-card" aria-labelledby="li-pend">${StatusBadge({ kind: 'pending', label: 'En attente d’approbation' })}
    <h2 class="card__title" id="li-pend">LinkedIn n’est pas encore accessible</h2>
    <p>${esc(scrub((ps && ps.message) || 'LinkedIn n’a pas encore accordé l’accès à ses statistiques.'))} Aucune valeur n’est affichée en attendant : le tableau de bord ne montre jamais de chiffre estimé.</p>
    <p>La procédure à suivre est détaillée dans les <a class="text-link" href="#/settings">Paramètres</a>.</p></section>
    <section class="card" aria-labelledby="li-future"><h2 class="card__title" id="li-future">Ce qui s’affichera après l’accès</h2><span class="card__sub">Chaque bloc nécessite une autorisation (scope) LinkedIn.</span>
    <ul class="future-list">${FUTURE.map(([n, d, sc]) => `<li><div><strong>${esc(n)}</strong><span class="muted">${esc(d)}</span></div><code>${esc(sc)}</code></li>`).join('')}</ul></section>`;
}

const BLOCK_NAME = { organization: 'Organisation', followers: 'Audience', pageStats: 'Statistiques de la Page', posts: 'Publications', postStats: 'Statistiques des publications', dailyImpressions: 'Impressions quotidiennes', reactions: 'Réactions par type', comments: 'Commentaires' };
const STATE = { scope_missing: ['warn', 'Autorisation manquante'], not_available: ['neutral', 'Indisponible'], budget_exhausted: ['info', 'Budget d’appels atteint'] };
const unresolved = (k) => (typeof k === 'string' ? `Valeur non résolue (${k})` : 'Valeur non résolue');
const FACET_NAME = { association: 'Association', country: 'Pays', function: 'Fonction', seniority: 'Ancienneté', industry: 'Secteur', staffCount: 'Taille de l’entreprise', region: 'Région', byCountry: 'Pays', byRegion: 'Région', byFunction: 'Fonction', bySeniority: 'Ancienneté', byIndustry: 'Secteur', byStaffCount: 'Taille de l’entreprise' };

function facetBlock(name, items, topN) {
  if (!Array.isArray(items) || !items.length) return '';
  const list = items.map((x) => ({ label: unresolved(x.key), value: x.count })).filter((x) => isNum(x.value));
  if (!list.length) return '';
  const total = list.reduce((s, x) => s + x.value, 0);
  return `<div class="facet">${BarList({ title: `${name} · cumul des ${number(list.length)} premières valeurs : ${number(total)}`, items: list, max: 8, color: 'var(--c-linkedin)', total })}
    ${AltTable({ caption: `${name}, ${number(list.length)} valeurs (identifiants non résolus, top ${number(topN || 100)})`, columns: ['Valeur', 'Nombre'], rows: list.map((x) => [x.label, number(x.value)]) })}</div>`;
}

function blockNotices(blocks) {
  const bad = Object.entries(blocks || {}).filter(([, b]) => b && b.state && b.state !== 'ok');
  if (!bad.length) return '';
  return `<section class="card" aria-labelledby="li-blocks"><h2 class="card__title" id="li-blocks">Blocs indisponibles</h2><ul class="block-list">${bad.map(([k, b]) => {
    const [kind, label] = STATE[b.state] || ['neutral', STATUS_LABEL[b.state] || 'Indisponible'];
    return `<li><strong>${esc(BLOCK_NAME[k] || k)}</strong>${StatusBadge({ kind, label })}<span class="muted">${esc(scrub(b.reason || ''))}</span></li>`;
  }).join('')}</ul></section>`;
}

export function linkedinSections({ stats, posts, period }) {
  const d = stats.details || {}, blocks = d.blocks || {}, okBlock = (k) => !blocks[k] || blocks[k].state === 'ok';
  const parts = [blockNotices(blocks)];
  let after = () => {};

  const o = d.organization;
  if (o && okBlock('organization')) {
    const staff = o.staffCountRange && typeof o.staffCountRange === 'object' && isNum(o.staffCountRange.start) ? `${number(o.staffCountRange.start)}${isNum(o.staffCountRange.end) ? `–${number(o.staffCountRange.end)}` : '+'} employés` : typeof o.staffCountRange === 'string' ? esc(o.staffCountRange) : null;
    const facts = Facts([['Nom', o.name ? esc(o.name) : null], ['Identifiant public', o.vanityName ? esc(o.vanityName) : null], ['Type', o.type ? esc(o.type) : null], ['Taille', staff],
      ['Site web', o.website ? ExternalLink({ href: /^https?:/i.test(o.website) ? o.website : `https://${o.website}`, label: o.website.replace(/^https?:\/\//i, '').slice(0, 60) }) : null]]);
    const desc = o.description ? `<p class="bio">${esc(o.description)}</p>` : '';
    if (facts || desc) parts.push(Fold({ id: 'li-org', title: 'Organisation', sub: 'Informations de la Page', body: desc + facts }));
  }

  const f = d.followers;
  if (f && okBlock('followers')) {
    const latest = f.latestDataDate || null, ref = latest ? new Date(`${latest}T00:00:00`) : null;
    const gains = (f.gains || []).filter((g) => !ref || new Date(`${g.date}T00:00:00`) > new Date(ref.getTime() - period * 86400000));
    const gSum = (k) => (gains.some((g) => isNum(g[k])) ? gains.reduce((s, g) => s + (isNum(g[k]) ? g[k] : 0), 0) : null);
    const kpis = `<div class="kpis kpis--ins" style="--cols:3;--cols-md:3" role="group" aria-label="Audience">
      ${isNum(f.total) ? KpiCard({ label: 'Abonnés', value: f.total, deltaReason: 'Total actuel de la Page.' }) : ''}
      ${isNum(gSum('organic')) ? KpiCard({ label: 'Gain organique', value: gSum('organic'), deltaReason: `Sur ${period} jours${latest ? ` jusqu’au ${fmtDate(latest)}` : ''}.` }) : ''}
      ${isNum(gSum('paid')) ? KpiCard({ label: 'Gain payant', value: gSum('paid'), deltaReason: `Sur ${period} jours${latest ? ` jusqu’au ${fmtDate(latest)}` : ''}.` }) : ''}</div>`;
    const facets = Object.entries(f.facets || {}).map(([k, items]) => facetBlock(FACET_NAME[k] || k, items, f.facetsTopN)).join('');
    parts.push(Fold({ id: 'li-aud', title: 'Audience', sub: 'Abonnés de la Page, gains et répartition', body: kpis + (facets ? `<p class="muted">Les répartitions sont des identifiants LinkedIn non résolus : le tableau de bord n’en devine pas le libellé.</p><div class="grid grid-2-eq">${facets}</div>` : ''), open: false }));
  }

  const ps = d.pageStats;
  if (ps && okBlock('pageStats')) {
    const daily = ps.daily || [], t = ps.total || {};
    const chart = hasSignal(daily.map((x) => x.pageViews)) ? MiniChart({ id: 'li-pagestats', title: 'Pages vues et visiteurs uniques par jour', height: 'sm',
      summary: `Pages vues : ${number(daily.reduce((s, x) => s + (isNum(x.pageViews) ? x.pageViews : 0), 0))} sur ${daily.length} jours.`, columns: ['Date', 'Pages vues', 'Visiteurs uniques'], rows: daily.map((x) => [fmtDay(x.date), isNum(x.pageViews) ? number(x.pageViews) : 'n.d.', isNum(x.uniqueVisitors) ? number(x.uniqueVisitors) : 'n.d.']) }) : '';
    const maps = (title, m) => BarList({ title, items: Object.entries(m || {}).filter(([, v]) => isNum(v)).map(([label, value]) => ({ label, value })).sort((a, b) => b.value - a.value), color: 'var(--c-linkedin)' });
    const clicks = ['desktop', 'mobile'].map((dev) => BarList({ title: `Clics (${dev === 'desktop' ? 'ordinateur' : 'mobile'})`, items: (ps.clicks && ps.clicks[dev] || []).filter((c) => isNum(c.count)).map((c) => ({ label: c.type || 'Autre', value: c.count })), color: 'var(--c-linkedin)' })).join('');
    const kp = `<div class="kpis kpis--ins" style="--cols:2;--cols-md:2" role="group" aria-label="Statistiques de la Page">${isNum(t.pageViews) ? KpiCard({ label: 'Pages vues', value: t.pageViews, deltaReason: ps.window ? `Du ${fmtDate(ps.window.start)} au ${fmtDate(ps.window.end)}.` : 'Fenêtre fournie par LinkedIn.' }) : ''}${isNum(t.uniquePageViews) ? KpiCard({ label: 'Pages vues uniques', value: t.uniquePageViews, deltaReason: 'Visiteurs uniques de la fenêtre.' }) : ''}</div>`;
    const body = kp + chart + `<div class="grid grid-2-eq">${maps('Sections consultées', ps.bySection)}${maps('Appareils', ps.byDevice)}${clicks}</div>`;
    parts.push(Fold({ id: 'li-page', title: 'Statistiques de la Page', sub: 'Visites de la Page LinkedIn', body }));
    after = () => { if ($('#li-pagestats')) Charts.lines($('#li-pagestats'), { labels: daily.map((x) => x.date), series: [{ label: 'Pages vues', data: daily.map((x) => x.pageViews), platform: 'linkedin', connect: true }, { label: 'Visiteurs uniques', data: daily.map((x) => x.uniqueVisitors), color: Charts.theme().gray, dash: [6, 4], connect: true }] }); };
  }

  // Publications : réactions par type, non mesurées, sponsorisées exclues
  const rt = d.reactionsByType, labels = d.reactionLabels || {};
  const reactions = rt && okBlock('reactions') ? Object.entries(rt).filter(([, v]) => isNum(v)).map(([k, v]) => ({ label: labels[k] || k, value: v })).sort((a, b) => b.value - a.value) : [];
  const cov = d.coverage || {};
  const unmeasured = posts.filter((p) => p.measured === false).length;
  const pubBody = `${isNum(cov.statsMeasuredFor) && isNum(cov.organicPosts) ? `<p class="muted">${number(cov.statsMeasuredFor)} publication${cov.statsMeasuredFor > 1 ? 's' : ''} mesurée${cov.statsMeasuredFor > 1 ? 's' : ''} sur ${number(cov.organicPosts)} organiques${unmeasured ? ` ; ${number(unmeasured)} « non mesurée${unmeasured > 1 ? 's' : ''} » dans la période (aucune valeur n’est estimée)` : ''}.</p>` : ''}
    ${reactions.length ? BarList({ title: 'Réactions par type (publications collectées)', items: reactions, color: 'var(--c-linkedin)' }) : EmptyState({ title: 'Réactions par type indisponibles', cause: okBlock('reactions') ? 'LinkedIn n’a fourni aucune réaction détaillée.' : 'Ce bloc nécessite une autorisation supplémentaire (voir « Blocs indisponibles »).' })}`;
  parts.push(Fold({ id: 'li-pubs', title: 'Publications et réactions', sub: 'Impressions, clics et réactions par publication dans le tableau ci-dessous', body: pubBody }));

  const sp = d.sponsoredPosts || [];
  if (sp.length) {
    parts.push(Fold({ id: 'li-sponsored', title: 'Publications sponsorisées (exclues)', sub: `${number(sp.length)} publication${sp.length > 1 ? 's' : ''} non comptée${sp.length > 1 ? 's' : ''} dans les statistiques organiques`,
      body: `<ul class="block-list">${sp.map((x) => `<li><strong>${esc(x.title || 'Publication sans titre')}</strong><span class="muted">${esc(fmtDate(x.publishedAt))}${x.measured === false ? ' · non mesurée' : ''}</span>${x.url ? ExternalLink({ href: x.url, label: 'Voir' }) : ''}</li>`).join('')}</ul>` }));
  }

  const b = d.budget;
  const budget = b && isNum(b.used) && isNum(b.limit) ? `<p class="muted budget-note">Appels LinkedIn aujourd’hui : ${number(b.used)} sur ${number(b.limit)}${b.resetsAt ? ` · remise à zéro ${esc(fmtDateTime(b.resetsAt))}` : ''}.</p>` : '';
  parts.push(budget);

  const limits = [...plainNotes(d.notes), ...plainNotes((stats.source && stats.source.notes) || []),
    'Les statistiques LinkedIn ont un décalage d’environ deux jours (J-2) : les derniers jours peuvent être vides.',
    'Seuls les 12 derniers mois sont consultables.',
    'Seules les publications organiques sont comptées : les publications sponsorisées sont exclues.',
    d.retention && isNum(d.retention.commentsHours) ? `Les commentaires LinkedIn sont conservés ${number(d.retention.commentsHours)} h au maximum.` : null,
    "Les mesures « non mesuré » ne sont jamais remplacées par 0."];
  return { markup: parts.join(''), limits: LimitsPanel(limits), after };
}
export { pct };
