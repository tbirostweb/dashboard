// Connecteur LinkedIn : OAuth 2.0 (3-legged) + Community Management API (Page entreprise).
// Tant que LinkedIn n'a pas approuvé le produit « Community Management API » pour l'app
// (LINKEDIN_COMMUNITY_API=false), le connecteur est en état « pending_approval » : aucun OAuth,
// aucun appel, aucune donnée (même fictive).
//
// Sources (consultées le 30/09/2026, version « Latest » 202609) :
//  - https://learn.microsoft.com/linkedin/marketing/community-management/community-management-overview
//  - https://learn.microsoft.com/linkedin/marketing/community-management/organizations/organization-lookup-api
//      GET /rest/organizations/{id}, GET /rest/networkSizes/{orgUrn}?edgeType=COMPANY_FOLLOWED_BY_MEMBER — rw_organization_admin
//  - https://learn.microsoft.com/linkedin/marketing/community-management/organizations/follower-statistics — rw_organization_admin
//  - https://learn.microsoft.com/linkedin/marketing/community-management/organizations/share-statistics — rw_organization_admin
//  - https://learn.microsoft.com/linkedin/marketing/community-management/shares/posts-api — r_organization_social
//  - https://learn.microsoft.com/linkedin/marketing/community-management/shares/comments-api — r_organization_social_feed
//  - https://learn.microsoft.com/linkedin/marketing/versioning — en-têtes Linkedin-Version (AAAAMM) et X-Restli-Protocol-Version: 2.0.0
import { fetchJson, ProviderError, scrub } from '../http.js';
import { mapLimit, titleFrom, toIso, num, isoDay } from '../util.js';
import { sentiment } from '../sentiment.js';

const AUTH_URL = 'https://www.linkedin.com/oauth/v2/authorization';
const TOKEN_URL = 'https://www.linkedin.com/oauth/v2/accessToken';
const API = 'https://api.linkedin.com';
const DAY = 86_400_000;
const HISTORY_DAYS = 190;

const enc = encodeURIComponent;
const POSTS_PAGE = 100;
const SHARE_BATCH = 20;
const FACET_TOP_N = 100;
export const COMMENTS_RETENTION_HOURS = 48; // contrainte LinkedIn : activité sociale de membres, 48 h max en cache
export const REACTION_LABELS = { LIKE: 'J\'aime', PRAISE: 'Bravo', EMPATHY: 'Adore', INTEREST: 'Instructif', APPRECIATION: 'Soutien', ENTERTAINMENT: 'Amusant' };

const FOLLOWER_FACETS = {
  association: ['followerCountsByAssociationType'],
  country: ['followerCountsByGeoCountry', 'followerCountsByCountry'],
  region: ['followerCountsByGeo', 'followerCountsByRegion'],
  function: ['followerCountsByFunction'],
  seniority: ['followerCountsBySeniority'],
  industry: ['followerCountsByIndustry'],
  staffCount: ['followerCountsByStaffCountRange']
};
const FACET_KEYS = ['geo', 'country', 'region', 'function', 'seniority', 'industry', 'industryV2', 'staffCountRange', 'associationType'];

export const utcDay = (ms) => new Date(ms).toISOString().slice(0, 10);
export const startOfUtcDay = (ms) => Math.floor(ms / DAY) * DAY;
const numOrNull = (v) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));

/** Liste de facettes { key (URN non résolu), count }, triée, top 100 ; null si absente. */
function facetList(el, names, valueOf) {
  const arr = names.map((n) => el[n]).find(Array.isArray);
  if (!arr) return null;
  return arr
    .map((x) => ({ key: FACET_KEYS.map((k) => x[k]).find((v) => v !== undefined && v !== null) ?? null, count: numOrNull(valueOf(x)) }))
    .sort((a, b) => (b.count ?? -1) - (a.count ?? -1))
    .slice(0, FACET_TOP_N);
}

/** Publication sponsorisée / « dark » : hors agrégats organiques. */
export const isSponsored = (p) => Boolean(
  (p.adContext && p.adContext.isDsc === true) ||
  p.feedDistribution === 'NONE' || (p.distribution && p.distribution.feedDistribution === 'NONE')
);

/**
 * Chemin de l'appel de statistiques par publication. INCERTAIN : la doc montre `shares=List(...)`/`ugcPosts=List(...)`
 * mais aussi la notation indexée `ugcPosts[0]=...` ; style 'list' par défaut, 'indexed' en repli.
 */
export function buildShareStatsPath(orgUrn, ids, style = 'list') {
  const q = ['q=organizationalEntity', `organizationalEntity=${enc(orgUrn)}`];
  const shares = ids.filter((id) => id.startsWith('urn:li:share:'));
  const ugc = ids.filter((id) => id.startsWith('urn:li:ugcPost:'));
  const add = (name, list) => {
    if (!list.length) return;
    if (style === 'indexed') list.forEach((id, i) => q.push(`${name}[${i}]=${enc(id)}`));
    else q.push(`${name}=List(${list.map(enc).join(',')})`);
  };
  add('shares', shares);
  add('ugcPosts', ugc);
  return `organizationalEntityShareStatistics?${q.join('&')}`;
}

/** reactionSummaries (objet ou tableau) → { LIKE: n, … } */
function parseReactions(meta) {
  const rs = meta && meta.reactionSummaries;
  const out = {};
  if (!rs) return out;
  const entries = Array.isArray(rs) ? rs.map((x) => [x.reactionType, x]) : Object.entries(rs).map(([k, x]) => [(x && x.reactionType) || k, x]);
  entries.forEach(([k, x]) => { const n = numOrNull(x && x.count); if (k && n !== null) out[k] = n; });
  return out;
}

function postType(p) {
  const c = p.content || {};
  if (c.article) return 'Article';
  if (c.multiImage) return 'Image';
  if (c.poll) return 'Sondage';
  const id = (c.media && c.media.id) || '';
  if (id.includes(':video:')) return 'Vidéo';
  if (id.includes(':document:')) return 'Document';
  if (id.includes(':image:')) return 'Image';
  return 'Texte';
}

export const PENDING_MESSAGE = "En attente d'approbation LinkedIn : le produit « Community Management API » n'est pas encore accordé à l'application.";

export function createLinkedInProvider(cfg, { fetch = globalThis.fetch, now = () => Date.now() } = {}) {
  const c = cfg.linkedin;
  const P = 'linkedin';
  const orgUrn = c.organizationId ? `urn:li:organization:${c.organizationId}` : null;

  function tokenFrom(d, prev = {}) {
    if (!d.access_token) throw new ProviderError(P, 'auth', 'Échec OAuth LinkedIn.');
    return {
      accessToken: d.access_token,
      refreshToken: d.refresh_token || prev.refreshToken || null, // refresh token : uniquement pour certaines apps validées
      expiresAt: now() + num(d.expires_in || 60 * 86400) * 1000,
      refreshExpiresAt: d.refresh_token_expires_in ? now() + num(d.refresh_token_expires_in) * 1000 : (prev.refreshExpiresAt || null),
      scope: d.scope || c.scopes
    };
  }

  const pendingError = (detail) => new ProviderError(P, 'pending_approval', `${PENDING_MESSAGE}${detail ? ` (${detail})` : ''}`);

  // ---------------------------------------------------------------- Budget d'appels (Development tier : 500/jour/app, 100/jour/membre, RAZ 00:00 UTC)
  // Compteur EN MÉMOIRE par jour UTC : il repart à zéro au redémarrage du backend (limite connue).
  const spent = { day: null, used: 0 };
  const budgetLimit = () => { const v = Number(c.dailyCallBudget ?? 80); return Number.isFinite(v) && v >= 0 ? Math.floor(v) : 80; };
  const reserve = () => { const v = Number(c.priorityReserve ?? Math.min(25, Math.floor(budgetLimit() / 3))); return Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0; };
  const rollDay = () => { const d = utcDay(now()); if (spent.day !== d) { spent.day = d; spent.used = 0; } };
  const budgetState = () => {
    rollDay();
    return { used: spent.used, limit: budgetLimit(), resetsAt: new Date(startOfUtcDay(now()) + DAY).toISOString() };
  };

  /**
   * Appel LinkedIn décompté. tier 1 = essentiel (organisation, followers, posts, stats) ; tier 2 = détails
   * (commentaires, réactions), refusés quand il ne reste plus que la réserve prioritaire.
   * force : diagnostic manuel (compté, jamais bloqué). ctx.halted : 429 reçu → plus aucun appel pendant ce cycle.
   */
  async function rest(path, token, { tier = 1, force = false, ctx = null } = {}) {
    if (ctx && ctx.halted) throw new ProviderError(P, 'rate_limit', 'Limite de requêtes LinkedIn atteinte (429) : appels suspendus pour ce cycle.', 429);
    rollDay();
    if (!force) {
      const cap = tier >= 2 ? Math.max(0, budgetLimit() - reserve()) : budgetLimit();
      if (spent.used >= cap) throw new ProviderError(P, 'budget', `Budget d'appels LinkedIn du jour atteint (${spent.used}/${budgetLimit()}).`);
    }
    spent.used++;
    try {
      return await fetchJson(fetch, P, `${API}/rest/${path}`, {
        headers: { Authorization: `Bearer ${token}`, 'Linkedin-Version': c.apiVersion, 'X-Restli-Protocol-Version': '2.0.0' }
      });
    } catch (err) {
      if (err.code === 'rate_limit' && ctx) ctx.halted = true; // pas de retry en boucle
      throw err;
    }
  }

  const hasFeedScope = () => String(c.scopes || '').split(/[\s,]+/).includes('r_organization_social_feed');

  async function orgData(t, notes, token) {
    const ctx = { halted: false };
    const call = (path, opts = {}) => rest(path, t, { ...opts, ctx });
    const out = { followers: null, posts: [], comments: [], dailyViews: {}, dailyNewFollowers: {}, org: null, details: null, sponsoredPosts: [] };
    const blocks = {};
    const BLOCKS = ['organization', 'followers', 'pageStats', 'posts', 'postStats', 'dailyImpressions', 'reactions', 'comments'];
    BLOCKS.forEach((b) => { blocks[b] = { state: 'ok', reason: null }; });
    const SCOPE = { organization: 'rw_organization_admin', followers: 'rw_organization_admin', pageStats: 'rw_organization_admin', posts: 'r_organization_social', postStats: 'rw_organization_admin', dailyImpressions: 'rw_organization_admin', reactions: 'r_organization_social_feed', comments: 'r_organization_social_feed' };
    const NAME = { organization: 'Informations de la Page', followers: 'Followers', pageStats: 'Statistiques de Page', posts: 'Publications', postStats: 'Statistiques des publications', dailyImpressions: 'Impressions quotidiennes', reactions: 'Réactions par type', comments: 'Commentaires' };
    const mark = (block, state, reason) => { if (blocks[block].state === 'ok') blocks[block] = { state, reason }; };
    let budgetNoted = false;
    const denied = [];
    const guard = async (block, fn, label = NAME[block]) => {
      try { return await fn(); } catch (err) {
        if (err.code === 'auth') throw err;
        if (err.code === 'budget') {
          mark(block, 'budget_exhausted', `Budget d'appels LinkedIn du jour atteint (${spent.used}/${budgetLimit()}) : bloc reporté après 00:00 UTC.`);
          if (!budgetNoted) { budgetNoted = true; notes.push(`Budget d'appels LinkedIn du jour atteint (${spent.used}/${budgetLimit()}) : certains blocs sont reportés à la réinitialisation de 00:00 UTC.`); }
        } else if (err.code === 'permission') {
          denied.push(label);
          const reason = `${label} : accès refusé (403). Scope ${SCOPE[block]} non accordé ou compte non administrateur de la Page.`;
          mark(block, 'scope_missing', reason);
          notes.push(reason);
        } else {
          const reason = err.code === 'rate_limit' ? `${label} : limite de requêtes LinkedIn atteinte (429).` : `${label} indisponible (${err.message}).`;
          mark(block, 'not_available', reason);
          notes.push(reason);
        }
        return null;
      }
    };

    // ---- Organisation + total de followers
    const org = await guard('organization', () => call(`organizations/${enc(c.organizationId)}`), 'Informations de la Page');
    out.org = org;
    const orgDenied = denied.length;
    const ns = await guard('followers', () => call(`networkSizes/${enc(orgUrn)}?edgeType=COMPANY_FOLLOWED_BY_MEMBER`), 'Nombre de followers');
    if (ns) out.followers = num(ns.firstDegreeSize);
    // Les deux appels « organisation » de base refusés (403 / ACCESS_DENIED) → accès pas encore accordé
    if (orgDenied === 1 && denied.length === 2) throw pendingError('403 ACCESS_DENIED sur les endpoints organisation');
    if (ctx.halted && !org && !ns) throw new ProviderError(P, 'rate_limit', 'Limite de requêtes LinkedIn atteinte (429).', 429);

    // ---- Gains quotidiens (J-12 mois → J-2 UTC, end exclusif)
    const folEnd = startOfUtcDay(now()) - 2 * DAY;
    const folStart = folEnd - (HISTORY_DAYS - 5) * DAY;
    const tiFol = `timeIntervals=(timeRange:(start:${folStart},end:${folEnd}),timeGranularityType:DAY)`;
    const folSeries = await guard('followers', () => call(`organizationalEntityFollowerStatistics?q=organizationalEntity&organizationalEntity=${enc(orgUrn)}&${tiFol}`), 'Gains de followers quotidiens');
    const gains = [];
    ((folSeries && folSeries.elements) || []).forEach((e) => {
      if (!e.timeRange || !e.followerGains) return;
      const organic = numOrNull(e.followerGains.organicFollowerGain);
      const paid = numOrNull(e.followerGains.paidFollowerGain);
      const date = utcDay(e.timeRange.start);
      gains.push({ date, organic, paid });
      out.dailyNewFollowers[isoDay(e.timeRange.start)] = (organic ?? 0) + (paid ?? 0);
    });
    gains.sort((a, b) => a.date.localeCompare(b.date));
    // Facettes cumulées (top 100 par facette ; valeurs = organicFollowerCount, qui cumule organique + payant)
    const folCum = await guard('followers', () => call(`organizationalEntityFollowerStatistics?q=organizationalEntity&organizationalEntity=${enc(orgUrn)}`), 'Facettes de followers');
    const facets = { association: null, country: null, function: null, seniority: null, industry: null, staffCount: null, region: null };
    const fEl = folCum && (folCum.elements || [])[0];
    if (fEl) {
      for (const [k, names] of Object.entries(FOLLOWER_FACETS)) facets[k] = facetList(fEl, names, (x) => x.followerCounts && x.followerCounts.organicFollowerCount);
    }

    // ---- Publications (pagination, fenêtre 190 j, plafond de pages)
    const cutoff = now() - HISTORY_DAYS * DAY;
    const maxPages = Math.max(1, Math.floor(Number(c.maxPostPages ?? 5)) || 5);
    const rawAll = [];
    let truncated = false;
    let postsOk = false;
    for (let page = 0; page < maxPages; page++) {
      const r = await guard('posts', () => call(`posts?q=author&author=${enc(orgUrn)}&count=${POSTS_PAGE}&sortBy=LAST_MODIFIED&start=${page * POSTS_PAGE}`));
      if (!r) break;
      postsOk = true;
      const els = r.elements || [];
      rawAll.push(...els);
      const last = els[els.length - 1];
      const lastTs = last ? num(last.lastModifiedAt || last.publishedAt || last.createdAt) : 0;
      const more = els.length >= POSTS_PAGE && (r.paging && Number.isFinite(Number(r.paging.total)) ? (page + 1) * POSTS_PAGE < Number(r.paging.total) : true);
      if (!more || lastTs < cutoff) break;
      if (page === maxPages - 1) truncated = true;
    }
    const inWindow = rawAll.filter((p) => num(p.publishedAt || p.createdAt) >= cutoff && (!p.lifecycleState || p.lifecycleState === 'PUBLISHED'));
    const sponsoredRaw = inWindow.filter(isSponsored);
    const rawPosts = inWindow.filter((p) => !isSponsored(p));
    if (truncated) notes.push(`Publications tronquées : plafond de ${maxPages} page(s) de ${POSTS_PAGE} atteint avant la fin de la fenêtre.`);
    if (sponsoredRaw.length) notes.push(`${sponsoredRaw.length} publication(s) sponsorisée(s) ou « dark » écartée(s) des agrégats organiques.`);

    // ---- Statistiques par publication (lots de 20, 12 mois glissants, cumul depuis publication)
    const stats = new Map();
    let statsOk = true;
    let listStyle = c.shareStatsListStyle === 'indexed' ? 'indexed' : 'list';
    for (let i = 0; i < rawPosts.length; i += SHARE_BATCH) {
      const batch = rawPosts.slice(i, i + SHARE_BATCH).map((p) => p.id);
      const run = (style) => call(buildShareStatsPath(orgUrn, batch, style));
      const r = await guard('postStats', async () => {
        try { return await run(listStyle); } catch (err) {
          // Format de liste incertain : repli sur la notation indexée en cas de 400
          if (err.status === 400) { listStyle = listStyle === 'list' ? 'indexed' : 'list'; return run(listStyle); }
          throw err;
        }
      });
      if (!r) { statsOk = false; break; }
      (r.elements || []).forEach((e) => stats.set(e.share || e.ugcPost, e.totalShareStatistics || {}));
    }

    // ---- Réactions par type + commentaires (scope r_organization_social_feed) : détails, tier 2
    const social = new Map();
    let reactionsTotal = null;
    if (!hasFeedScope()) {
      mark('reactions', 'scope_missing', 'Réactions par type : scope r_organization_social_feed non accordé (absent de LINKEDIN_SCOPES).');
      notes.push('Réactions par type : scope non accordé (r_organization_social_feed).');
    } else if (rawPosts.length) {
      const maxR = Math.max(0, Math.floor(Number(c.reactionsMaxPosts ?? 15)));
      const targets = [...rawPosts].sort((a, b) => num(b.publishedAt || b.createdAt) - num(a.publishedAt || a.createdAt)).slice(0, maxR);
      await mapLimit(targets, 3, async (p) => {
        const r = await guard('reactions', () => call(`socialMetadata/${enc(p.id)}`, { tier: 2 }), 'Réactions par type');
        if (r) social.set(p.id, r);
      });
      if (social.size) {
        reactionsTotal = {};
        social.forEach((m) => { Object.entries(parseReactions(m)).forEach(([k, v]) => { reactionsTotal[k] = (reactionsTotal[k] || 0) + v; }); });
      }
    }

    let negativeLikes = 0;
    const mapPost = (p) => {
      const s = stats.get(p.id);
      const measured = Boolean(s);
      const rawLikes = measured ? numOrNull(s.likeCount) : null;
      if (rawLikes !== null && rawLikes < 0) negativeLikes++;
      const meta = social.get(p.id);
      const rbt = meta ? parseReactions(meta) : null;
      const eng = measured ? numOrNull(s.engagement) : null;
      const zero = (v) => (measured ? num(v) : (statsOk ? 0 : null)); // absent d'une réponse réussie = 0 (non mesuré) ; échec = inconnu
      return {
        id: `li-${p.id.split(':').pop()}`,
        urn: p.id,
        platform: P,
        type: postType(p),
        title: titleFrom(p.commentary, 'Publication LinkedIn'),
        publishedAt: toIso(num(p.publishedAt || p.createdAt)),
        views: num(s && s.impressionCount),
        likes: Math.max(0, num(s && s.likeCount)), // legacy : likeCount négatif ramené à 0
        comments: num(s && s.commentCount),
        shares: num(s && s.shareCount),
        saves: 0,
        url: `https://www.linkedin.com/feed/update/${p.id}/`,
        impressions: zero(s && s.impressionCount),
        uniqueImpressions: zero(s && s.uniqueImpressionsCount),
        clicks: zero(s && s.clickCount),
        reactions: rawLikes !== null && rawLikes < 0 ? null : (measured ? rawLikes : (statsOk ? 0 : null)),
        engagementRate: eng === null ? null : eng * 100, // `engagement` est un ratio : exposé en %
        measured,
        sponsored: false,
        reactionsByType: rbt
      };
    };
    out.posts = rawPosts.map(mapPost);
    out.sponsoredPosts = sponsoredRaw.map((p) => ({
      id: `li-${p.id.split(':').pop()}`,
      platform: P,
      type: postType(p),
      title: titleFrom(p.commentary, 'Publication LinkedIn'),
      publishedAt: toIso(num(p.publishedAt || p.createdAt)),
      url: `https://www.linkedin.com/feed/update/${p.id}/`,
      sponsored: true,
      measured: false
    }));
    if (negativeLikes) notes.push(`likeCount négatif renvoyé par LinkedIn sur ${negativeLikes} publication(s) : réactions inconnues (null), likes ramenés à 0 dans les agrégats.`);
    const missing = rawPosts.filter((p) => !stats.has(p.id)).length;
    if (statsOk && postsOk && missing) notes.push(`${missing} publication(s) absente(s) de la réponse de statistiques : comptées à 0 mais non mesurées (measured: false).`);

    // ---- Statistiques de Page (cumul + série)
    const pageStats = { daily: [], bySection: null, byDevice: null, byCountry: null, byRegion: null, byFunction: null, bySeniority: null, byIndustry: null, byStaffCount: null, clicks: null, window: null };
    const cum = await guard('pageStats', () => call(`organizationPageStatistics?q=organization&organization=${enc(orgUrn)}`), 'Statistiques de Page (cumul)');
    const cEl = cum && (cum.elements || [])[0];
    if (cEl) {
      const tv = (cEl.totalPageStatistics && cEl.totalPageStatistics.views) || {};
      const pv = (k) => numOrNull(tv[k] && tv[k].pageViews);
      pageStats.bySection = { overview: pv('overviewPageViews'), careers: pv('careersPageViews'), jobs: pv('jobsPageViews'), lifeAt: pv('lifeAtPageViews') };
      pageStats.byDevice = { desktop: pv('allDesktopPageViews'), mobile: pv('allMobilePageViews') };
      pageStats.total = { pageViews: pv('allPageViews'), uniquePageViews: numOrNull(tv.allPageViews && tv.allPageViews.uniquePageViews) };
      const tc = (cEl.totalPageStatistics && cEl.totalPageStatistics.clicks) || {};
      const clicks = (arr) => (Array.isArray(arr) ? arr.map((x) => ({ type: x.customButtonType || null, count: numOrNull(x.count) })) : null);
      pageStats.clicks = { desktop: clicks(tc.desktopCustomButtonClickCounts), mobile: clicks(tc.mobileCustomButtonClickCounts) };
      const pageVal = (x) => x.pageStatistics && x.pageStatistics.views && x.pageStatistics.views.allPageViews && x.pageStatistics.views.allPageViews.pageViews;
      pageStats.byCountry = facetList(cEl, ['pageStatisticsByGeoCountry', 'pageStatisticsByCountry'], pageVal);
      pageStats.byRegion = facetList(cEl, ['pageStatisticsByGeo', 'pageStatisticsByRegion'], pageVal);
      pageStats.byFunction = facetList(cEl, ['pageStatisticsByFunction'], pageVal);
      pageStats.bySeniority = facetList(cEl, ['pageStatisticsBySeniority'], pageVal);
      pageStats.byIndustry = facetList(cEl, ['pageStatisticsByIndustryV2', 'pageStatisticsByIndustry'], pageVal);
      pageStats.byStaffCount = facetList(cEl, ['pageStatisticsByStaffCountRange'], pageVal);
    }
    const gran = String(c.pageStatsGranularity || 'DAY').toUpperCase() === 'MONTH' ? 'MONTH' : 'DAY';
    const psDays = Math.max(1, Math.floor(Number(c.pageStatsDays ?? 90)) || 90);
    const psEnd = now();
    const psStart = psEnd - psDays * DAY;
    const tiPs = `timeIntervals=(timeRange:(start:${psStart},end:${psEnd}),timeGranularityType:${gran})`;
    const ser = await guard('pageStats', () => call(`organizationPageStatistics?q=organization&organization=${enc(orgUrn)}&${tiPs}`), 'Statistiques de Page (série)');
    if (ser) {
      ((ser.elements) || []).forEach((e) => {
        if (!e.timeRange) return;
        const v = (e.totalPageStatistics && e.totalPageStatistics.views && e.totalPageStatistics.views.allPageViews) || {};
        pageStats.daily.push({ date: utcDay(e.timeRange.start), pageViews: numOrNull(v.pageViews), uniqueVisitors: numOrNull(v.uniquePageViews) });
      });
      pageStats.daily.sort((a, b) => a.date.localeCompare(b.date));
      pageStats.window = { start: utcDay(psStart), end: utcDay(psEnd), granularity: gran };
    }

    // ---- Impressions quotidiennes (série de la Page)
    const ti = `timeIntervals=(timeRange:(start:${psEnd - (HISTORY_DAYS - 5) * DAY},end:${psEnd}),timeGranularityType:DAY)`;
    const daily = await guard('dailyImpressions', () => call(`organizationalEntityShareStatistics?q=organizationalEntity&organizationalEntity=${enc(orgUrn)}&${ti}`));
    ((daily && daily.elements) || []).forEach((e) => {
      if (e.timeRange) out.dailyViews[isoDay(e.timeRange.start)] = num(e.totalShareStatistics && e.totalShareStatistics.impressionCount);
    });

    // ---- Commentaires (scope r_organization_social_feed), tier 2. Le nom des membres n'est pas résolu.
    const commented = out.posts.filter((p) => p.comments > 0 && Date.parse(p.publishedAt) >= now() - 90 * DAY).slice(0, Math.max(0, Math.floor(Number(c.commentsMaxPosts ?? 15))));
    let commentErrors = 0;
    const lists = await mapLimit(commented, 3, async (p) => {
      try {
        const r = await call(`socialActions/${enc(p.urn)}/comments?count=50`, { tier: 2 });
        return (r.elements || []).map((x, j) => {
          const text = (x.message && x.message.text) || '';
          const actor = x.actor || '';
          const isOrg = actor.startsWith('urn:li:organization:');
          return {
            id: `li-c-${x.id ? String(x.id).split(':').pop() : `${p.id}-${j}`}`,
            platform: P,
            postId: p.id,
            author: isOrg ? ((out.org && out.org.localizedName) || 'Page LinkedIn') : 'Membre LinkedIn',
            handle: isOrg ? 'Page' : 'Membre',
            text,
            sentiment: sentiment(text),
            likes: num(x.likesSummary && (x.likesSummary.totalLikes ?? x.likesSummary.aggregatedTotalLikes)),
            createdAt: toIso(num(x.created && x.created.time)) || p.publishedAt
          };
        });
      } catch (err) {
        if (err.code === 'auth') throw err;
        commentErrors++;
        if (err.code === 'budget') mark('comments', 'budget_exhausted', `Budget d'appels LinkedIn du jour atteint (${spent.used}/${budgetLimit()}) : commentaires reportés.`);
        else if (err.code === 'permission') mark('comments', 'scope_missing', 'Commentaires : accès refusé, scope r_organization_social_feed non accordé.');
        else mark('comments', 'not_available', `Commentaires indisponibles (${err.message}).`);
        if (err.code === 'budget' && !budgetNoted) { budgetNoted = true; notes.push(`Budget d'appels LinkedIn du jour atteint (${spent.used}/${budgetLimit()}) : certains blocs sont reportés à la réinitialisation de 00:00 UTC.`); }
        return [];
      }
    });
    if (commentErrors) notes.push(`Commentaires illisibles sur ${commentErrors} publication(s) (scope r_organization_social_feed non accordé, budget ou limite).`);
    out.comments = lists.flat();
    out.posts.forEach((p) => { delete p.urn; });

    // ---- details
    const withState = (b, obj) => ({ ...obj, state: blocks[b].state, reason: blocks[b].reason });
    const o = org || {};
    const orgOk = Boolean(org);
    out.details = {
      organization: withState('organization', {
        name: orgOk ? (o.localizedName ?? null) : null,
        vanityName: orgOk ? (o.vanityName ?? null) : null,
        website: orgOk ? (o.localizedWebsite ?? null) : null,
        description: orgOk ? (o.localizedDescription ?? null) : null, // champs admin : absents sans rôle ADMINISTRATOR
        staffCountRange: orgOk ? (o.staffCountRange ?? null) : null,
        industries: orgOk ? (o.industries ?? null) : null,
        foundedOn: orgOk ? (o.foundedOn ?? null) : null,
        type: orgOk ? (o.primaryOrganizationType ?? null) : null
        // logoV2 : URN non résolu, l'URL du logo n'est volontairement pas exposée
      }),
      followers: withState('followers', {
        total: out.followers,
        gains: folSeries ? gains : null,
        facets: folCum ? facets : null,
        facetsTopN: FACET_TOP_N,
        latestDataDate: gains.length ? gains[gains.length - 1].date : null
      }),
      pageStats: withState('pageStats', pageStats),
      reactionsByType: reactionsTotal,
      reactionLabels: REACTION_LABELS,
      coverage: {
        postsFetched: postsOk ? inWindow.length : null,
        organicPosts: postsOk ? rawPosts.length : null,
        sponsoredExcluded: postsOk ? sponsoredRaw.length : null,
        truncated: postsOk ? truncated : null,
        statsMeasuredFor: stats.size ? rawPosts.filter((p) => stats.has(p.id)).length : 0,
        windowMonths: 12
      },
      sponsoredPosts: out.sponsoredPosts,
      blocks,
      budget: budgetState(),
      retention: { commentsHours: COMMENTS_RETENTION_HOURS },
      notes
    };
    return out;
  }

  return {
    id: P,
    label: 'LinkedIn',
    get capabilities() { return { comments: Boolean(c.communityApi && orgUrn) }; },
    /** true tant que LinkedIn n'a pas accordé Community Management (drapeau de config). */
    get pendingApproval() { return !c.communityApi; },

    authorizeUrl(state) {
      const q = new URLSearchParams({ response_type: 'code', client_id: c.clientId, redirect_uri: c.redirectUri, state, scope: c.scopes });
      return `${AUTH_URL}?${q}`;
    },

    async exchangeCode(code) {
      const d = await fetchJson(fetch, P, TOKEN_URL, {
        method: 'POST',
        form: { grant_type: 'authorization_code', code, redirect_uri: c.redirectUri, client_id: c.clientId, client_secret: c.clientSecret }
      });
      return tokenFrom(d);
    },

    /** Token : 60 j. Refresh token seulement pour certaines apps ; sinon il faut se reconnecter. */
    needsRefresh(token) {
      return Boolean(token.refreshToken) && token.expiresAt - now() < 7 * DAY;
    },

    async refresh(token) {
      if (!token.refreshToken) return null;
      const d = await fetchJson(fetch, P, TOKEN_URL, {
        method: 'POST',
        form: { grant_type: 'refresh_token', refresh_token: token.refreshToken, client_id: c.clientId, client_secret: c.clientSecret }
      });
      return tokenFrom(d, token);
    },

    async revoke(token) {
      await fetchJson(fetch, P, 'https://www.linkedin.com/oauth/v2/revoke', {
        method: 'POST',
        form: { token: token.accessToken, client_id: c.clientId, client_secret: c.clientSecret }
      });
    },

    async fetchData(token) {
      if (!c.communityApi) throw pendingError();
      if (!orgUrn) throw new ProviderError(P, 'config', 'LINKEDIN_ORGANIZATION_ID manquant.');
      const notes = [];
      const o = await orgData(token.accessToken, notes, token);
      const vanity = o.org && o.org.vanityName;
      return {
        account: {
          platform: P,
          name: (o.org && o.org.localizedName) || 'Page LinkedIn',
          handle: vanity || c.organizationId,
          url: `https://www.linkedin.com/company/${vanity || c.organizationId}/`
        },
        followers: o.followers,
        posts: o.posts,
        comments: o.comments,
        dailyViews: o.dailyViews,
        dailyNewFollowers: o.dailyNewFollowers,
        commentsRetentionHours: COMMENTS_RETENTION_HOURS,
        details: o.details,
        notes
      };
    },

    /**
     * Diagnostic pas à pas des appels organisation. Ne renvoie jamais de token :
     * uniquement statut HTTP, code d'erreur et message nettoyé.
     */
    async diagnose(token) {
      const steps = [];
      const run = async (name, scope, fn) => {
        try {
          const detail = await fn();
          steps.push({ step: name, scope, ok: true, ...(detail ? { detail } : {}) });
          return true;
        } catch (err) {
          steps.push({ step: name, scope, ok: false, httpStatus: err.status || null, code: err.code || 'error', message: scrub(err.message) });
          return false;
        }
      };
      const t = token.accessToken;
      const restForce = (path, tk) => rest(path, tk, { force: true });
      let firstPost = null;
      await run('organizations/{id}', 'rw_organization_admin', async () => {
        const o = await restForce(`organizations/${enc(c.organizationId)}`, t);
        return `Page : ${o.localizedName || '?'} (${o.vanityName || c.organizationId})`;
      });
      await run('networkSizes (followers)', 'rw_organization_admin', async () => {
        const n = await restForce(`networkSizes/${enc(orgUrn)}?edgeType=COMPANY_FOLLOWED_BY_MEMBER`, t);
        return `${num(n.firstDegreeSize)} followers`;
      });
      await run('posts?q=author', 'r_organization_social', async () => {
        const r = await restForce(`posts?q=author&author=${enc(orgUrn)}&count=5&sortBy=LAST_MODIFIED`, t);
        firstPost = (r.elements || [])[0] || null;
        return `${(r.elements || []).length} publication(s) lue(s)`;
      });
      await run('organizationalEntityShareStatistics (lifetime)', 'rw_organization_admin', async () => {
        const r = await restForce(`organizationalEntityShareStatistics?q=organizationalEntity&organizationalEntity=${enc(orgUrn)}`, t);
        const s = ((r.elements || [])[0] || {}).totalShareStatistics || {};
        return `${num(s.impressionCount)} impressions (total)`;
      });
      await run('organizationalEntityFollowerStatistics (7 j)', 'rw_organization_admin', async () => {
        const end = now() - 2 * DAY;
        const r = await restForce(`organizationalEntityFollowerStatistics?q=organizationalEntity&organizationalEntity=${enc(orgUrn)}&timeIntervals=(timeRange:(start:${end - 7 * DAY},end:${end}),timeGranularityType:DAY)`, t);
        return `${(r.elements || []).length} jour(s)`;
      });
      if (firstPost) {
        await run('socialActions/{post}/comments', 'r_organization_social_feed', async () => {
          const r = await restForce(`socialActions/${enc(firstPost.id)}/comments?count=5`, t);
          return `${(r.elements || []).length} commentaire(s) sur la dernière publication`;
        });
      } else {
        steps.push({ step: 'socialActions/{post}/comments', scope: 'r_organization_social_feed', ok: null, detail: 'non testé (aucune publication lue)' });
      }
      return steps;
    }
  };
}
