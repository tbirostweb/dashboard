// Fusion des paliers : le palier LÉGER (compteurs, médias récents) met à jour le jeu de données sans écraser ce que
// le palier LOURD (insights par média, audience, commentaires, historique complet, miniatures) a apporté.
const defined = (o) => Object.fromEntries(Object.entries(o || {}).filter(([, v]) => v !== undefined && v !== null));
const time = (p) => { const t = Date.parse(p.publishedAt); return Number.isFinite(t) ? t : 0; };

/**
 * @param {object} prev   dernier jeu de données (léger fusionné ou lourd) ; null au premier chargement
 * @param {object} light  résultat partiel du palier léger
 * @param {string[]} heavyKeys champs de publication issus du palier lourd (conservés si le léger ne les fournit pas)
 */
export function mergeLight(prev, light, { heavyKeys = [] } = {}) {
  if (!prev) return { ...light, comments: light.comments === undefined ? [] : light.comments, partial: true };

  const prevById = new Map((prev.posts || []).map((p) => [p.id, p]));
  const lightPosts = (light.posts || []).map((p) => {
    const old = prevById.get(p.id);
    if (!old) return { ...p, views: p.views ?? 0, shares: p.shares ?? 0 };
    const m = { ...old, ...p };
    for (const k of heavyKeys) m[k] = p[k] ?? old[k] ?? null;
    m.views = m.views ?? 0;
    m.shares = m.shares ?? 0;
    return m;
  });
  // Le palier léger ne lit que la première page : les publications plus anciennes viennent du dernier palier lourd.
  const oldestLight = lightPosts.length ? Math.min(...lightPosts.map(time)) : Infinity;
  const seen = new Set(lightPosts.map((p) => p.id));
  const kept = (prev.posts || []).filter((p) => !seen.has(p.id) && time(p) < oldestLight);
  const posts = [...lightPosts, ...kept].sort((a, b) => time(b) - time(a));

  const ld = light.details || {};
  const pd = prev.details || {};
  const { profile: lightProfile, ...lightRest } = ld;
  const details = Object.keys(ld).length || prev.details
    ? { ...pd, ...defined(lightRest), profile: { ...(pd.profile || {}), ...defined(lightProfile) } }
    : null;

  return {
    ...prev,
    account: light.account || prev.account,
    followers: Number.isFinite(light.followers) ? light.followers : prev.followers,
    posts,
    dailyViews: { ...(prev.dailyViews || {}), ...(light.dailyViews || {}) },
    dailyNewFollowers: { ...(prev.dailyNewFollowers || {}), ...(light.dailyNewFollowers || {}) },
    details,
    partial: Boolean(prev.partial) // tant qu'aucun palier lourd n'est passé, le jeu reste partiel
  };
}

/** Un palier lourd remplace le jeu de données ; il conserve seulement les totaux « dernières 24 h » du léger. */
export function applyHeavy(prev, heavy) {
  const today = prev && prev.details && prev.details.today;
  const out = { ...heavy, partial: false };
  if (today && out.details && typeof out.details === 'object' && out.details.today === undefined) out.details = { ...out.details, today };
  return out;
}
