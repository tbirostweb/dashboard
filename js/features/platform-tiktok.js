/* TikTok : profil, cadence, meilleurs jours/heures (calculés côté client sur les vidéos de la période), tranches de durée, durée vs vues,
   et encart honnête sur ce que l'API TikTok ne fournit pas. */
import { esc, isNum, number, pct, fmtDate, relTime } from '../core/format.js?v=15';
import { KpiCard, Fold, StatusBadge, EmptyState, ExternalLink } from '../ui/components.js?v=15';
import { Facts, LimitsPanel, MiniChart, groupStats, heatGrid, DAYS_FR, slotLabel, fmtLong } from './social-shared.js?v=15';
import { plainNotes } from './platform-instagram.js?v=15';

const Charts = window.Charts;
const $ = (sel, root = document) => root.querySelector(sel);
const MIN_SLOT = 3; // en deçà, un créneau n'est pas interprétable

function heatmap(posts) {
  const grid = heatGrid(posts);
  const rates = grid.flat().map((c) => c.rate).filter(isNum);
  const max = rates.length ? Math.max(...rates) : 0;
  const best = grid.flatMap((row, d) => row.map((c, h) => ({ ...c, d, h }))).filter((c) => c.posts >= MIN_SLOT && isNum(c.rate)).sort((a, b) => b.rate - a.rate)[0];
  const verdict = best ? `Meilleur créneau observé (au moins ${MIN_SLOT} vidéos) : ${DAYS_FR[best.d].toLowerCase()}, ${slotLabel(best.h)}, taux moyen ${pct(best.rate)} sur ${number(best.posts)} vidéos.`
    : `Échantillon insuffisant : aucun créneau ne compte ${MIN_SLOT} vidéos ou plus, aucun « meilleur moment » n’est désigné.`;
  const cell = (c) => {
    if (!c.posts) return '<td class="heat heat--none"><span aria-hidden="true">·</span><span class="sr-only">aucune vidéo</span></td>';
    const lvl = isNum(c.rate) && max > 0 ? Math.round(c.rate / max * 30) : 0;
    return `<td class="heat${c.posts < MIN_SLOT ? ' heat--thin' : ''}" style="--lvl:${lvl}"><span class="heat__v">${isNum(c.rate) ? esc(pct(c.rate)) : 'n.d.'}</span><span class="heat__n">${c.posts} vidéo${c.posts > 1 ? 's' : ''}</span></td>`;
  };
  return `<div class="notice notice--info notice--inline" role="note"><ul><li>Calculé sur ${number(posts.length)} vidéos de la période, en heure locale de votre navigateur. Les cases pointillées comptent moins de ${MIN_SLOT} vidéos : lecture indicative uniquement.</li></ul></div>
    <p>${esc(verdict)}</p>
    <div class="table-wrap"><table class="data heatmap"><caption class="sr-only">Taux d'engagement moyen des vidéos selon le jour et la tranche horaire de publication</caption>
    <thead><tr><th scope="col" class="left"><span class="sr-only">Jour</span></th>${Array.from({ length: 8 }, (_, i) => `<th scope="col">${slotLabel(i)}</th>`).join('')}</tr></thead>
    <tbody>${grid.map((row, d) => `<tr><th scope="row" class="left">${DAYS_FR[d]}</th>${row.map(cell).join('')}</tr>`).join('')}</tbody></table></div>`;
}

const bucketOrder = (k) => { const m = /\d+/.exec(k); return k.startsWith('≤') ? 0 : m ? Number(m[0]) : 999; };

export function tiktokSections({ stats, posts }) {
  const d = stats.details || {}, p = d.profile || {}, cad = d.cadence || {};
  const parts = [];
  const bio = p.bio ? `<p class="bio">${esc(p.bio)}</p>` : '';
  const facts = Facts([
    ['Statut', p.isVerified === true ? StatusBadge({ kind: 'info', label: 'Compte vérifié' }) : p.isVerified === false ? 'Non vérifié' : null],
    ['Abonnés', isNum(p.followerCount) ? number(p.followerCount) : null], ['Abonnements', isNum(p.followingCount) ? number(p.followingCount) : null],
    ['Total de j’aime reçus', isNum(p.likesCount) ? number(p.likesCount) : null], ['Vidéos publiées', isNum(p.videoCount) ? number(p.videoCount) : null],
    ['Lien du profil', p.profileDeepLink ? ExternalLink({ href: p.profileDeepLink, label: 'Ouvrir sur TikTok' }) : null]
  ]);
  if (bio || facts) parts.push(Fold({ id: 'tt-profile', title: 'Profil du compte', sub: 'Tel que publié sur TikTok', body: bio + facts }));

  const cadBody = (isNum(cad.postsPerWeek) || cad.lastPostAt) ? `<div class="kpis kpis--ins" style="--cols:2;--cols-md:2" role="group" aria-label="Cadence de publication">
    ${isNum(cad.postsPerWeek) ? KpiCard({ label: 'Vidéos par semaine', value: String(cad.postsPerWeek.toFixed(1)).replace('.', ','), deltaReason: 'Rythme moyen sur la fenêtre collectée.' }) : ''}
    ${cad.lastPostAt ? KpiCard({ label: 'Dernière publication', value: relTime(cad.lastPostAt), hint: fmtDate(cad.lastPostAt), deltaReason: 'Date de la vidéo la plus récente.' }) : ''}</div>` : '';
  if (cadBody) parts.push(Fold({ id: 'tt-cadence', title: 'Cadence de publication', sub: 'Régularité des vidéos', body: cadBody }));

  parts.push(Fold({ id: 'tt-heat', title: 'Meilleurs jours et heures de publication', sub: 'Taux d’engagement moyen par créneau', body: posts.length ? heatmap(posts) : EmptyState({ title: 'Aucune vidéo', cause: 'Aucune vidéo publiée sur la période.' }) }));

  const buckets = groupStats(posts, (x) => x.durationBucket).sort((a, b) => bucketOrder(a.key) - bucketOrder(b.key));
  const withDur = posts.filter((x) => isNum(x.durationSeconds) && isNum(x.views));
  let durBody = '';
  if (buckets.length) {
    durBody += MiniChart({ id: 'tt-buckets', title: 'Vues moyennes par tranche de durée', height: 'mini',
      summary: `Vues moyennes par tranche de durée : ${buckets.map((g) => `${g.key} ${isNum(g.avgAud) ? number(Math.round(g.avgAud)) : 'n.d.'} (${g.posts} vidéo${g.posts > 1 ? 's' : ''})`).join(', ')}.`,
      columns: ['Durée', 'Vidéos', 'Vues moyennes', "Taux d'engagement"], rows: buckets.map((g) => [g.key, number(g.posts), isNum(g.avgAud) ? number(Math.round(g.avgAud)) : 'n.d.', isNum(g.rate) ? pct(g.rate) : 'n.d.']) });
  }
  if (withDur.length >= 2) {
    durBody += MiniChart({ id: 'tt-scatter', title: 'Durée et vues de chaque vidéo', height: 'sm',
      summary: `${withDur.length} vidéos : durée de ${fmtLong(Math.min(...withDur.map((x) => x.durationSeconds)))} à ${fmtLong(Math.max(...withDur.map((x) => x.durationSeconds)))}, vues de ${number(Math.min(...withDur.map((x) => x.views)))} à ${number(Math.max(...withDur.map((x) => x.views)))}. Un nuage de points montre une tendance, pas une cause.`,
      columns: ['Vidéo', 'Durée', 'Vues'], rows: withDur.map((x) => [x.title || 'Sans titre', fmtLong(x.durationSeconds), number(x.views)]) });
  }
  parts.push(Fold({ id: 'tt-duration', title: 'Durée des vidéos', sub: 'Tranches de durée et relation avec les vues', body: durBody || EmptyState({ title: 'Durées indisponibles', cause: 'TikTok n’a pas fourni la durée des vidéos de cette période.' }) }));

  parts.push(`<section class="card" aria-labelledby="tt-limits"><h2 class="card__title" id="tt-limits">Ce que l’API TikTok ne fournit pas</h2><ul class="limits__list">
    <li><strong>Commentaires</strong> : ils ne sont pas accessibles, la page Commentaires n’affiche rien pour TikTok.</li>
    <li><strong>Démographie de l’audience</strong> : âge, genre et pays des spectateurs ne sont pas communiqués.</li>
    <li><strong>Vues par jour</strong> : la courbe des vues additionne les vues des vidéos publiées chaque jour, elle n’est pas une audience quotidienne.</li>
    <li><strong>Enregistrements</strong> : le nombre d’ajouts aux favoris n’est pas fourni.</li></ul></section>`);

  const limits = [...plainNotes(d.notes), ...plainNotes((stats.source && stats.source.notes) || []),
    'Les interactions sont rattachées au jour de publication de chaque vidéo.',
    "Les adresses d'images des vidéos expirent : une miniature absente est remplacée par une icône."];
  return {
    markup: parts.join(''), limits: LimitsPanel(limits),
    after() {
      const t = Charts.theme();
      if ($('#tt-buckets')) Charts.bars($('#tt-buckets'), { labels: buckets.map((g) => `${g.key} (${g.posts})`), series: [{ label: 'Vues moyennes', data: buckets.map((g) => (isNum(g.avgAud) ? Math.round(g.avgAud) : null)), color: t.platform.tiktok }], tooltipFormat: number });
      if ($('#tt-scatter')) Charts.scatter($('#tt-scatter'), { series: [{ label: 'Vidéos', color: t.platform.tiktok, points: withDur.map((x) => ({ x: x.durationSeconds, y: x.views })) }], xLabel: 'Durée (secondes)', yLabel: 'Vues', tooltipFormat: (r) => ` ${fmtLong(r.x)} → ${number(r.y)} vues` });
    }
  };
}
