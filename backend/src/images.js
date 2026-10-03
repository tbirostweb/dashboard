// Assainissement des URL d'images renvoyées par les plateformes (avatars, miniatures, couvertures).
// Ces URL sont signées et EXPIRENT : elles ne sont jamais persistées, seulement relayées au navigateur,
// qui les charge directement (CSP img-src : mêmes suffixes, voir nginx.conf).

/** Suffixes d'hôtes autorisés (l'hôte doit être un sous-domaine du suffixe, comme le joker *.suffixe du CSP). */
export const IMAGE_HOST_SUFFIXES = Object.freeze({
  instagram: ['cdninstagram.com', 'fbcdn.net', 'fbsbx.com'],
  tiktok: ['tiktokcdn.com', 'tiktokcdn-us.com', 'tiktokcdn-eu.com', 'ibytedtos.com', 'tiktok.com'],
  linkedin: ['licdn.com']
});
export const ALL_IMAGE_SUFFIXES = Object.freeze([...new Set(Object.values(IMAGE_HOST_SUFFIXES).flat())]);

const MAX_LENGTH = 2048;

/** URL https d'un CDN connu, sans identifiants, port ni fragment ; sinon null. Renvoie l'URL normalisée. */
export function sanitizeImageUrl(url) {
  if (typeof url !== 'string' || !url || url.length > MAX_LENGTH) return null;
  if (/[\s\u0000-\u001f\u007f\\]/.test(url)) return null;
  let u;
  try { u = new URL(url); } catch { return null; }
  if (u.protocol !== 'https:') return null;
  if (u.username || u.password || u.hash || u.port) return null;
  if (url.includes('#') || /^https:\/\/[^/?]*@/i.test(url)) return null;
  const host = u.hostname.toLowerCase();
  if (!host || host.endsWith('.') || !/^[a-z0-9.-]+$/.test(host)) return null;
  // Sous-domaines uniquement (comme le joker *.suffixe du CSP) : « evilfbcdn.net » ou « fbcdn.net.attacker.com » sont refusés
  const ok = ALL_IMAGE_SUFFIXES.some((s) => host.endsWith(`.${s}`));
  return ok ? u.href : null;
}

/** Lien https sans identifiants (permaliens de publications) ; sinon null. Pas de liste d'hôtes : le lien s'ouvre dans un autre onglet. */
export function sanitizeLinkUrl(url) {
  if (typeof url !== 'string' || !url || url.length > MAX_LENGTH || /[\s\u0000-\u001f\u007f\\]/.test(url)) return null;
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && !u.username && !u.password ? u.href : null;
  } catch { return null; }
}
