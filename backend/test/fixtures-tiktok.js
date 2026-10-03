// Fixtures TikTok FACTICES (formes de la doc Display API). Aucun appel réseau réel.
import { fakeFetch } from './helpers.js';

export const DAY = 86_400_000;
export const secs = (ms) => Math.floor(ms / 1000);
export const TT_TOKEN = { accessToken: 'act.fake-tiktok-access-token-0123456789abcdefghijklmnopqrstuvwxyz', refreshToken: 'rft.old-refresh', expiresAt: 0, userId: 'open-1' };

export const okEnv = (data) => ({ json: { data, error: { code: 'ok', message: '', log_id: 'x' } } });
export const errEnv = (code, status = 400) => ({ status, json: { error: { code, message: code, log_id: 'x' } } });

export const FULL_USER = {
  open_id: 'open-1', avatar_url: 'https://p16.example/avatar.jpeg?x-expires=1', display_name: 'Studio Test', username: 'studiotest',
  profile_deep_link: 'https://vm.tiktok.com/xyz', bio_description: 'Bio de test', is_verified: true,
  follower_count: 4200, following_count: 12, likes_count: 99000, video_count: 57
};

export const video = (now, daysAgo, over = {}) => ({
  id: String(1000 + daysAgo), title: `Vidéo ${daysAgo}`, create_time: secs(now - daysAgo * DAY), duration: 30,
  like_count: 100, comment_count: 10, share_count: 5, view_count: 2000, share_url: `https://www.tiktok.com/@studiotest/video/${1000 + daysAgo}`,
  cover_image_url: `https://p16.example/cover${daysAgo}.jpeg`, height: 1920, width: 1080, ...over
});

/**
 * Faux TikTok configurable. opts : user (objet | fonction fields -> réponse), pages (tableau de {videos, has_more, cursor}),
 * listFn (réponse personnalisée), query (fonction ids -> videos).
 */
export function ttFetch({ user = FULL_USER, pages = [], listFn, queryFn } = {}) {
  const hits = { user: [], list: [], query: [] };
  let p = 0;
  const f = fakeFetch([
    [/oauth\/token\//, (url, init) => ({ json: { access_token: 'act.new', expires_in: 86400, refresh_token: 'rft.new', refresh_expires_in: 31536000, open_id: 'open-1', scope: 'video.list' } })],
    [/v2\/user\/info\//, (url) => {
      const fields = new URL(url).searchParams.get('fields');
      hits.user.push(fields);
      return typeof user === 'function' ? user(fields) : okEnv({ user });
    }],
    [/v2\/video\/list\//, (url, init) => {
      const fields = new URL(url).searchParams.get('fields');
      hits.list.push({ fields, body: JSON.parse(init.body) });
      if (listFn) return listFn(fields, hits.list.length);
      const pg = pages[Math.min(p++, pages.length - 1)];
      return okEnv(pg);
    }],
    [/v2\/video\/query\//, (url, init) => {
      const ids = JSON.parse(init.body).filters.video_ids;
      hits.query.push(ids);
      return queryFn ? queryFn(ids) : okEnv({ videos: ids.map((id) => ({ id, cover_image_url: `https://p16.example/fresh${id}.jpeg` })) });
    }]
  ]);
  f.hits = hits;
  return f;
}
