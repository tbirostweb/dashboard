/* Page d'une plateforme (#/social/{instagram|tiktok|linkedin}). Squelette commun :
   en-tête du compte → barre d'outils → 6 KPI → UN graphique principal (sélecteur de métrique) → sections propres à la plateforme
   (repliables) → tableau des publications (DataTable, tri/filtre/export côté client). Les blocs spécifiques vivent dans platform-{instagram,tiktok,linkedin}.js. */
import { esc, isNum, number, numberCard, pct, fmtDay } from '../core/format.js?v=15';
import { PLATFORM_LABELS as LABELS, viewLabel as viewLabelOf, likesLabel, sharesLabel, engagementFormula } from '../core/labels.js?v=15';
import { KpiCard, kpiProps, Tabs, TabPanel, Toolbar, ExternalLink, Img, EmptyState, Fold, SectionHeader, AltTable, BlockLoading, StatusBadge } from '../ui/components.js?v=15';
import { SOCIAL_TABS } from './tabs.js?v=15';
import { state } from '../core/state.js?v=15';
import { attentionBadge } from '../core/token-logic.js?v=15';
import { blockLoading } from '../core/live-logic.js?v=15';
import { statusBadgeOf, hasNumbers, hasSignal, sumKnown, groupStats, MiniChart } from './social-shared.js?v=15';
import { PostsTable, rateTip } from './social-posts.js?v=15';
import { instagramSections } from './platform-instagram.js?v=15';
import { tiktokSections } from './platform-tiktok.js?v=15';
import { linkedinSections, linkedinPending } from './platform-linkedin.js?v=15';

const Api = window.Api, Charts = window.Charts;
const $ = (sel, root = document) => root.querySelector(sel);

export const title = ({ platform }) => LABELS[platform] || 'Plateforme';
export const eyebrow = '';
export const usesToolbar = true;

const NOUN = { instagram: 'publications', tiktok: 'vidéos', linkedin: 'publications' };
function coverageText(platform, cov, shown) {
  const noun = NOUN[platform] || 'publications';
  if (!cov || !isNum(cov.postsFetched)) return `${number(shown)} ${noun} sur la période.`;
  const days = isNum(cov.windowDays) ? ` sur ${number(Math.round(cov.windowDays))} jours` : '';
  return cov.truncated === true
    ? `Collecte partielle : les ${number(cov.postsFetched)} ${noun} les plus récentes${days} (plafond atteint, des publications plus anciennes peuvent manquer). ${number(shown)} dans la période affichée.`
    : `${number(cov.postsFetched)} ${noun} collectées${days} ; ${number(shown)} dans la période affichée.`;
}

/** Métriques du graphique principal. `key` → série journalière de /stats. */
function metricsOf(platform, s) {
  const vl = viewLabelOf(platform);
  const inter = s.dates.map((_, i) => { const v = [s.likes[i], s.comments[i], s.shares[i]].filter(isNum); return v.length ? v.reduce((a, b) => a + b, 0) : null; });
  const sub = {
    inter: 'Interactions rattachées au jour de publication de chaque contenu : les plateformes ne fournissent que des totaux par publication, pas de courbe quotidienne.',
    views: { instagram: 'Portée du compte par jour quand Meta la fournit, sinon somme des publications du jour.', tiktok: 'Somme des vues des vidéos publiées ce jour-là : TikTok ne fournit pas de vues par jour.', linkedin: 'Impressions quotidiennes de la Page quand disponibles, sinon somme par jour de publication.' }[platform],
    followers: 'Abonnés relevés à chaque synchronisation du tableau de bord ; les jours sans relevé restent vides.'
  };
  return [
    { key: 'interactions', label: 'Interactions', data: inter, sub: sub.inter },
    { key: 'views', label: vl, data: s.views, sub: sub.views },
    { key: 'likes', label: likesLabel(platform), data: s.likes, sub: sub.inter },
    { key: 'comments', label: 'Commentaires', data: s.comments, sub: sub.inter },
    { key: 'shares', label: sharesLabel(platform), data: s.shares, sub: sub.inter },
    { key: 'followers', label: 'Abonnés', data: s.followers, sub: sub.followers }
  ].filter((m) => hasNumbers(m.data));
}

function header(platform, stats, ps) {
  const d = stats.details || {}, prof = d.profile || {};
  const avatar = prof.profilePictureUrl || prof.avatarUrl || null;
  const a = stats.account || {};
  const tb = attentionBadge(ps && ps.token); // santé du jeton : seulement si ≠ ok
  return `<section class="card acct" aria-label="Compte ${esc(LABELS[platform])}">
    <span class="acct__avatar">${Img({ src: avatar, alt: '', size: 56, shape: 'round' })}</span>
    <div class="acct__id"><strong class="acct__name">${esc(a.name || LABELS[platform])}</strong><span class="acct__handle">${a.handle ? esc(a.handle) : 'Identifiant indisponible'}</span></div>
    ${statusBadgeOf((stats.source && stats.source.status) || 'connected')}${tb ? StatusBadge(tb) : ''}
    <a class="text-link acct__manage" href="#/settings">Gérer la connexion<span class="sr-only"> ${esc(LABELS[platform])} dans les paramètres</span></a>
    ${a.url ? `<span class="acct__link">${ExternalLink({ href: a.url, label: 'Voir le profil', ariaLabel: `Voir le profil ${LABELS[platform]}`, className: 'btn btn-ghost btn-small' })}</span>` : ''}
  </section>`;
}

export async function render(ctx) {
  const { platform } = ctx.params, P = ctx.period;
  const tabs = Tabs({ items: SOCIAL_TABS, current: platform, label: 'Réseaux sociaux' });
  // Toutes les lectures partent EN PARALLÈLE (statut, statistiques, publications, insights) : plus de cascade d'attente.
  const stP = Api.getStatus().catch(() => null);
  const statsP = Api.getPlatformStats(platform, { period: P }), postsP = Api.getPosts({ platform, period: P });
  const insP = platform === 'instagram' ? Api.getInsights(platform, { period: P }).catch((e) => { if (e && e.code === 'unauthenticated') throw e; return { error: e }; }) : null;
  [statsP, postsP].forEach((x) => x.catch(() => {})); if (insP) insP.catch(() => {});
  const st = await stP;
  const ps = st && st.mode === 'api' && st.platforms && st.platforms[platform];
  if (platform === 'linkedin' && ps && ps.status === 'pending_approval') {
    return { markup: Toolbar({ period: P, compare: false }) + tabs + TabPanel(platform, linkedinPending(ps)) };
  }
  const [stats, posts, insRaw] = await Promise.all([statsP, postsP, insP]);
  const ins = insRaw && platform === 'instagram' && ps && ['not_connected', 'expired', 'error'].includes(ps.status) ? null : insRaw;
  const k = stats.kpis, s = stats.series, vl = viewLabelOf(platform) || stats.viewLabel;
  const kp = (label, key, fmt = numberCard, opts = {}) => KpiCard({ label, value: k[key] && isNum(k[key].value) ? fmt(k[key].value) : null, ...kpiProps(k[key], { period: P, rate: opts.rate }), basis: opts.basis, hint: opts.hint });
  const metrics = metricsOf(platform, s);
  const connect = (data) => data.filter((v) => isNum(v)).length < data.length * 0.6;
  const extras = platform === 'instagram' ? instagramSections({ stats, ins, posts, period: P, announce: ctx.announce })
    : platform === 'tiktok' ? tiktokSections({ stats, posts, period: P })
      : linkedinSections({ stats, posts, period: P });

  // Types de publication (statistiques calculées sur les publications, valeurs connues uniquement)
  const types = groupStats(posts, (p) => p.type).sort((a, b) => (b.rate ?? -1) - (a.rate ?? -1));
  const typeRows = types.map((g) => [g.key, number(g.posts), isNum(g.avgInter) ? number(Math.round(g.avgInter)) : 'n.d.', isNum(g.rate) ? pct(g.rate) : 'n.d.']);
  const typeBody = types.length ? MiniChart({ id: 'pf-types', title: "Taux d'engagement par type", height: 'mini',
    summary: `Taux d'engagement par type : ${types.map((g) => `${g.key} ${isNum(g.rate) ? pct(g.rate) : 'non calculable'} (${g.posts} publication${g.posts > 1 ? 's' : ''})`).join(', ')}.`,
    columns: ['Type', 'Publications', 'Interactions moyennes', "Taux d'engagement"], rows: typeRows }) : '';

  // Blocs encore en cours côté serveur (palier lourd) : emplacement « Chargement… » par bloc, remplacé dès que le bloc arrive (le mode en direct relit plus vite tant qu'il en reste).
  const pendingBlocks = [
    platform === 'instagram' && blockLoading(stats, 'post_insights') && 'Insights par publication (portée, vues, enregistrements)',
    platform === 'tiktok' && blockLoading(stats, 'video_history') && 'Historique complet des vidéos',
    platform === 'tiktok' && blockLoading(stats, 'thumbnails') && 'Miniatures des vidéos'
  ].filter(Boolean);
  const body = `${header(platform, stats, ps)}
    <section class="kpis" aria-label="Indicateurs clés">
      ${kp('Abonnés', 'followers', numberCard)}
      ${kp(vl, 'views')}
      ${kp(likesLabel(platform), 'likes')}
      ${kp('Commentaires', 'comments')}
      ${kp(sharesLabel(platform), 'shares')}
      ${kp("Taux d'engagement", 'engagementRate', pct, { rate: true, basis: engagementFormula(stats.kpiEngagementBasis) })}
    </section>
    <div id="pf-chart-slot">${metrics.length ? '' : EmptyState({ title: 'Aucune donnée quotidienne', cause: 'La plateforme n’a fourni aucune mesure exploitable sur cette période.' })}</div>
    ${extras.markup}
    ${typeBody ? Fold({ id: 'pf-types-fold', title: 'Statistiques calculées sur les publications', sub: 'Par type de publication, à partir des mesures connues (inconnu ≠ 0)', body: typeBody }) : ''}
    ${extras.limits || ''}
    <section class="card" aria-labelledby="pf-posts">${SectionHeader({ title: 'Publications', id: 'pf-posts', sub: coverageText(platform, stats.coverage, posts.length), actions: rateTip(stats.engagementBasis) })}
      ${pendingBlocks.map((t) => BlockLoading({ text: `${t} : chargement en cours…`, lines: 1 })).join('')}
      ${posts.length ? PostsTable({ id: 'pf-table', platform, posts }) : EmptyState({ title: 'Aucune publication', cause: `Aucune publication ${LABELS[platform]} sur les ${P} derniers jours.`, action: P < 90 ? { label: 'Voir 90 jours', data: 'data-period="90"' } : undefined })}
    </section>`;

  return {
    markup: Toolbar({ period: P, compare: true, refresh: platform, updatedAt: stats.updatedAt }) + tabs + TabPanel(platform, body),
    after() {
      let chart = null, current = metrics[0] && metrics[0].key;
      const saved = state.ui.metric[platform]; if (saved && metrics.some((x) => x.key === saved)) current = saved; // choix conservé (mises à jour silencieuses, retour sur la page)
      const slot = $('#pf-chart-slot');
      const draw = (key) => {
        const m = metrics.find((x) => x.key === key) || metrics[0]; if (!m || !slot) return;
        current = m.key; state.ui.metric[platform] = m.key; Charts.destroy(chart); chart = null;
        const total = sumKnown(m.data), days = m.data.filter(isNum).length;
        const btns = `<div class="seg seg--sm" role="group" aria-label="Métrique du graphique">${metrics.map((x) => `<button type="button" data-metric="${x.key}" aria-pressed="${x.key === m.key}">${esc(x.label)}</button>`).join('')}</div>`;
        const card = `<section class="card chart-card" aria-labelledby="pf-main-t"><div class="card__head"><div><h2 class="card__title" id="pf-main-t">Évolution : ${esc(m.label)}</h2><span class="card__sub">${esc(m.sub || '')}</span></div>${btns}</div>`;
        if (!hasSignal(m.data)) {
          slot.innerHTML = `${card}${EmptyState({ title: 'Aucune valeur sur la période', cause: `${m.label} : aucune mesure supérieure à zéro sur ${P} jours.` })}</section>`; return;
        }
        const summary = `${m.label} sur ${P} jours : ${m.key === 'followers' ? `de ${number(m.data.find(isNum))} à ${number([...m.data].reverse().find(isNum))}` : `total ${number(total)}`}, ${days} jour${days > 1 ? 's' : ''} avec mesure${m.key !== 'followers' ? ' ; maximum ' + number(Math.max(...m.data.filter(isNum))) : ''}.`;
        const idx = s.dates.map((_, i) => i).filter((i) => isNum(m.data[i]));
        const alt = AltTable({ caption: `${m.label} par jour (jours avec mesure)`, columns: ['Date', m.label], rows: idx.map((i) => [fmtDay(s.dates[i]), number(m.data[i])]) });
        slot.innerHTML = `${card}<div class="chart-box chart-box--md"><canvas id="pf-main" role="img" tabindex="0" aria-labelledby="pf-main-t" aria-describedby="pf-main-s">${esc(summary)}</canvas></div><p class="chart-card__summary" id="pf-main-s">${esc(summary)}</p>${alt}</section>`;
        chart = Charts.lines($('#pf-main'), { labels: s.dates, series: [{ label: m.label, data: m.data, platform, connect: connect(m.data), fill: false }] });
      };
      if (metrics.length) {
        draw(current);
        slot.addEventListener('click', (e) => {
          const b = e.target.closest('[data-metric]'); if (!b || b.dataset.metric === current) return;
          draw(b.dataset.metric);
          const again = slot.querySelector(`[data-metric="${b.dataset.metric}"]`); if (again) again.focus();
          ctx.announce(`Graphique : ${b.textContent}.`);
        });
      }
      if (types.length && $('#pf-types')) {
        const t = Charts.theme();
        const known = types.filter((g) => isNum(g.rate));
        if (known.length) Charts.bars($('#pf-types'), { labels: known.map((g) => `${g.key} (${g.posts})`), horizontal: true, series: [{ label: "Taux d'engagement", data: known.map((g) => +g.rate.toFixed(2)), colors: known.map((_, i) => (i === 0 ? t.platform[platform] : t.soft)) }], yFormat: (v) => `${v} %`, tooltipFormat: (v) => pct(v) });
      }
      extras.after && extras.after();
    }
  };
}

