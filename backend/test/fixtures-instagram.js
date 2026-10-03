// Faux Graph API Instagram pour fetchData enrichi (profil, médias, insights par média). Aucun appel réseau réel.
import { fakeFetch } from './helpers.js';

export const DAY = 86_400_000;
const iso = (now, days) => new Date(now - days * DAY).toISOString().replace('.000Z', '+0000');
const err = (message, code = 100) => ({ status: 400, json: { error: { message, code } } });

// Valeurs d'insights par média (watch time en MILLISECONDES, comme Meta).
export const MEDIA_INSIGHTS = {
  r1: { reach: 800, views: 1000, likes: 80, comments: 2, shares: 7, saved: 12, reposts: 3, total_interactions: 104, ig_reels_avg_watch_time: 10000, ig_reels_video_view_total_time: 500000, reels_skip_rate: 40 },
  r2: { reach: 2000, views: 3000, likes: 200, comments: 5, shares: 9, saved: 30, reposts: 1, total_interactions: 245, ig_reels_avg_watch_time: 20000, ig_reels_video_view_total_time: 2000000, reels_skip_rate: 20 },
  f1: { reach: 600, views: 900, likes: 40, comments: 1, shares: 1, saved: 3, reposts: 0, total_interactions: 45, profile_visits: 8, follows: 2 }
};

/**
 * opts : followers, refuseProfilePic, refuseBio, refuseMediaFields (sous-chaîne de champs refusée),
 * rejectMetrics (métriques refusées par /insights), noInsightsFor (ids), mediaCount, commentsFor.
 */
export function igGraph(now, {
  followers = 1800, refuseProfilePic = false, refuseBio = false, refuseMediaFields = [], rejectMetrics = [],
  noInsightsFor = [], extraMedia = [], dropFields = []
} = {}) {
  const media = [
    { id: 'r1', caption: 'Reel <b>gras</b> & "quotes" 😀', media_type: 'VIDEO', media_product_type: 'REELS', permalink: 'https://www.instagram.com/reel/r1/', thumbnail_url: 'https://cdn.example.test/t1.jpg?sig=abc', media_url: 'https://cdn.example.test/v1.mp4', shortcode: 'r1', timestamp: iso(now, 3), like_count: 80, comments_count: 2 },
    { id: 'r2', caption: 'Second reel', media_type: 'VIDEO', media_product_type: 'REELS', permalink: 'https://www.instagram.com/reel/r2/', thumbnail_url: 'https://cdn.example.test/t2.jpg', timestamp: iso(now, 5), like_count: 200, comments_count: 0 },
    { id: 'f1', caption: '', media_type: 'IMAGE', media_product_type: 'FEED', permalink: 'https://www.instagram.com/p/f1/', media_url: 'https://cdn.example.test/p1.jpg', timestamp: iso(now, 8), like_count: 40, comments_count: 0 },
    ...extraMedia
  ];
  const mediaCalls = [];
  const insightCalls = [];
  const f = fakeFetch([
    [/graph\.instagram\.com\/v[\d.]+\/me\?fields=profile_picture_url/, () => (refuseProfilePic ? err('(#100) Tried accessing nonexisting field') : { json: { profile_picture_url: 'https://cdn.example.test/me.jpg?sig=zz', follows_count: 321, id: '1789' } })],
    [/graph\.instagram\.com\/v[\d.]+\/me\?fields=biography/, () => (refuseBio ? err('(#100) Tried accessing nonexisting field') : { json: { biography: '<i>Bio</i> 🎬', website: 'https://example.test', id: '1789' } })],
    [/graph\.instagram\.com\/v[\d.]+\/me\?fields=user_id/, () => ({ json: { user_id: '1789', username: 'studio.test', name: 'Studio Test', account_type: 'BUSINESS', followers_count: followers, media_count: media.length } })],
    [/graph\.instagram\.com\/v[\d.]+\/me\?fields=followers_count/, () => ({ json: { followers_count: followers } })],
    [/graph\.instagram\.com\/v[\d.]+\/me\/media\?/, (url) => {
      const fields = new URL(url).searchParams.get('fields');
      mediaCalls.push(fields);
      if (refuseMediaFields.some((x) => fields.includes(x))) return err('(#100) nonexisting field');
      const data = media.map((m) => {
        const o = { ...m };
        if (fields.includes('reposts_count')) Object.assign(o, { reposts_count: 4, saved_count: 15, shares_count: 8, total_views_count: 1111 });
        if (!fields.includes('media_url')) { delete o.media_url; delete o.thumbnail_url; delete o.shortcode; }
        dropFields.forEach((k) => delete o[k]);
        return o;
      });
      return { json: { data } };
    }],
    [/graph\.instagram\.com\/v[\d.]+\/[a-z0-9]+\/insights/, (url) => {
      const id = new URL(url).pathname.split('/').at(-2);
      const metrics = new URL(url).searchParams.get('metric').split(',');
      insightCalls.push({ id, metrics });
      if (noInsightsFor.includes(id)) return err('(#100) not supported');
      if (metrics.some((m) => rejectMetrics.includes(m))) return err('(#100) metric not supported for this media');
      const table = MEDIA_INSIGHTS[id] || {};
      return { json: { data: metrics.filter((m) => m in table).map((m) => ({ name: m, period: 'lifetime', values: [{ value: table[m] }] })) } };
    }],
    [/graph\.instagram\.com\/v[\d.]+\/me\/insights\?metric=reach/, () => ({ json: { data: [{ name: 'reach', values: [{ value: 5, end_time: iso(now, 0) }] }] } })],
    [/graph\.instagram\.com\/v[\d.]+\/me\/insights\?metric=follower_count/, () => ({ json: { data: [{ name: 'follower_count', values: [{ value: 2, end_time: iso(now, 0) }] }] } })],
    [/graph\.instagram\.com\/v[\d.]+\/[a-z0-9]+\/comments/, () => ({ json: { data: [{ id: 'c1', text: '<script>alert(1)</script> super 😍', username: 'fan', timestamp: iso(now, 1), like_count: 1 }] } })]
  ]);
  f.mediaCalls = mediaCalls;
  f.insightCalls = insightCalls;
  return f;
}
