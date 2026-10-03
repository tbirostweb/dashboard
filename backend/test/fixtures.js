// Réponses FACTICES des API des plateformes (formes tirées de la documentation officielle).
import { fakeFetch } from './helpers.js';

const DAY = 86_400_000;
const secs = (ms) => Math.floor(ms / 1000);

export const TT_ACCESS = 'act.fake-tiktok-access-token-0123456789abcdefghijklmnopqrstuvwxyz';
export const IG_SHORT = 'IGQfake-short-lived-token';
export const IG_LONG = 'IGAAfake-long-lived-token-0123456789abcdefghijklmnopqrstuvwxyz';
export const LI_ACCESS = 'AQfake-linkedin-access-token-0123456789abcdefghijklmnopqrstuvwxyz';

export function platformRoutes(now = Date.now(), overrides = {}) {
  const hits = { ttUser: 0, ttVideos: 0 };
  const routes = [
    // ---------------- TikTok
    [/open\.tiktokapis\.com\/v2\/oauth\/token\//, (url, init) => {
      const body = new URLSearchParams(init.body);
      if (body.get('grant_type') === 'refresh_token') {
        return { json: { access_token: 'act.refreshed', expires_in: 86400, refresh_token: 'rft.refreshed', refresh_expires_in: 31536000, open_id: 'open-1', scope: 'user.info.basic,video.list', token_type: 'Bearer' } };
      }
      if (body.get('code') !== 'good-code') return { json: { error: 'invalid_grant', error_description: 'Authorization code is expired.' } };
      return { json: { access_token: TT_ACCESS, expires_in: 86400, refresh_token: 'rft.fake', refresh_expires_in: 31536000, open_id: 'open-1', scope: 'user.info.basic,user.info.stats,video.list', token_type: 'Bearer' } };
    }],
    [/open\.tiktokapis\.com\/v2\/oauth\/revoke\//, () => ({ json: {} })],
    [/open\.tiktokapis\.com\/v2\/user\/info\//, () => {
      hits.ttUser++;
      return { json: { data: { user: { open_id: 'open-1', display_name: 'Studio Test', username: 'studiotest', profile_deep_link: 'https://vm.tiktok.com/xyz', follower_count: 4200, likes_count: 99 } }, error: { code: 'ok', message: '', log_id: 'x' } } };
    }],
    [/open\.tiktokapis\.com\/v2\/video\/list\//, () => {
      hits.ttVideos++;
      return {
        json: {
          data: {
            videos: [
              { id: '111', title: 'Vidéo récente', create_time: secs(now - 2 * DAY), duration: 30, like_count: 100, comment_count: 10, share_count: 5, view_count: 2000, share_url: 'https://www.tiktok.com/@studiotest/video/111' },
              { id: '222', video_description: 'Description longue\nsur deux lignes', create_time: secs(now - 20 * DAY), duration: 120, like_count: 50, comment_count: 2, share_count: 1, view_count: 900 },
              { id: '333', title: 'Trop ancienne', create_time: secs(now - 400 * DAY), duration: 10, like_count: 1, comment_count: 0, share_count: 0, view_count: 10 }
            ],
            cursor: 123, has_more: false
          },
          error: { code: 'ok', message: '', log_id: 'y' }
        }
      };
    }],

    // ---------------- Instagram
    [/api\.instagram\.com\/oauth\/access_token/, (url, init) => {
      const body = new URLSearchParams(init.body);
      if (body.get('code') !== 'good-code') return { status: 400, json: { error_type: 'OAuthException', code: 400, error_message: 'Invalid code' } };
      return { json: { data: [{ access_token: IG_SHORT, user_id: '1789', permissions: 'instagram_business_basic,instagram_business_manage_insights' }] } };
    }],
    [/graph\.instagram\.com\/access_token\?/, () => ({ json: { access_token: IG_LONG, token_type: 'bearer', expires_in: 5183944 } })],
    [/graph\.instagram\.com\/refresh_access_token\?/, () => ({ json: { access_token: 'IGAArefreshed', token_type: 'bearer', expires_in: 5183944 } })],
    [/graph\.instagram\.com\/v[\d.]+\/me\?fields=/, () => ({ json: { user_id: '1789', username: 'studio.test', name: 'Studio Test', account_type: 'BUSINESS', followers_count: 1800, media_count: 2 } })],
    [/graph\.instagram\.com\/v[\d.]+\/me\/media\?/, () => ({
      json: {
        data: [
          { id: 'm1', caption: 'Nouveau reel ✨\nsuite', media_type: 'VIDEO', media_product_type: 'REELS', permalink: 'https://www.instagram.com/reel/m1/', timestamp: new Date(now - 3 * DAY).toISOString().replace('.000Z', '+0000'), like_count: 80, comments_count: 2 },
          { id: 'm2', caption: '', media_type: 'CAROUSEL_ALBUM', media_product_type: 'FEED', permalink: 'https://www.instagram.com/p/m2/', timestamp: new Date(now - 10 * DAY).toISOString().replace('.000Z', '+0000'), like_count: 40, comments_count: 0 }
        ],
        paging: { cursors: {} }
      }
    })],
    [/graph\.instagram\.com\/v[\d.]+\/m1\/insights/, () => ({ json: { data: [{ name: 'reach', period: 'lifetime', values: [{ value: 1500 }] }, { name: 'saved', values: [{ value: 12 }] }, { name: 'shares', values: [{ value: 7 }] }, { name: 'views', values: [{ value: 2500 }] }] } })],
    // m2 : la 1re combinaison de métriques échoue, la 2e réussit (dégradation propre)
    [(url) => /\/m2\/insights\?metric=reach%2Csaved%2Cshares%2Cviews|\/m2\/insights\?metric=reach,saved,shares,views/.test(url), () => ({ status: 400, json: { error: { message: 'metric not supported', code: 100 } } })],
    [/graph\.instagram\.com\/v[\d.]+\/m2\/insights/, () => ({ json: { data: [{ name: 'reach', total_value: { value: 600 } }, { name: 'saved', values: [{ value: 3 }] }, { name: 'shares', values: [{ value: 1 }] }] } })],
    [/graph\.instagram\.com\/v[\d.]+\/me\/insights\?metric=reach/, () => ({ json: { data: [{ name: 'reach', period: 'day', values: [{ value: 321, end_time: new Date(now).toISOString().replace('.000Z', '+0000') }] }] } })],
    [/graph\.instagram\.com\/v[\d.]+\/me\/insights\?metric=follower_count/, () => ({ status: 400, json: { error: { message: 'Not enough followers', code: 100 } } })],
    [/graph\.instagram\.com\/v[\d.]+\/m1\/comments/, () => ({
      json: { data: [
        { id: 'c1', text: 'Super travail, merci !', timestamp: new Date(now - 2 * DAY).toISOString().replace('.000Z', '+0000'), username: 'fan_1', like_count: 3 },
        { id: 'c2', text: 'Le lien ne fonctionne pas', timestamp: new Date(now - 1 * DAY).toISOString().replace('.000Z', '+0000'), username: 'critique' }
      ] }
    })],

    // ---------------- LinkedIn
    [/www\.linkedin\.com\/oauth\/v2\/accessToken/, (url, init) => {
      const body = new URLSearchParams(init.body);
      if (body.get('code') !== 'good-code') return { status: 400, json: { error: 'invalid_request', error_description: 'Unable to retrieve access token' } };
      return { json: { access_token: LI_ACCESS, expires_in: 5184000, scope: 'openid,profile' } };
    }],
    [/www\.linkedin\.com\/oauth\/v2\/revoke/, () => ({ json: {} })],
    [/api\.linkedin\.com\/v2\/userinfo/, () => ({ json: { sub: 'abc', name: 'Théo Test', given_name: 'Théo' } })],
    [/api\.linkedin\.com\/rest\/organizations\//, () => ({ json: { id: 146243022, localizedName: 'Studio Test SAS', vanityName: 'studio-test' } })],
    [/api\.linkedin\.com\/rest\/networkSizes\//, () => ({ json: { firstDegreeSize: 777 } })],
    [/api\.linkedin\.com\/rest\/posts\?/, () => ({
      json: { elements: [
        { id: 'urn:li:share:9001', commentary: 'Étude de cas : +62 %', publishedAt: now - 4 * DAY, lifecycleState: 'PUBLISHED', content: { media: { id: 'urn:li:document:1' } } },
        { id: 'urn:li:ugcPost:9002', commentary: 'Nous recrutons', publishedAt: now - 8 * DAY, lifecycleState: 'PUBLISHED' }
      ] }
    })],
    [(url) => /organizationalEntityShareStatistics/.test(url) && /timeIntervals/.test(url), () => ({
      json: { elements: [{ timeRange: { start: now - DAY, end: now }, totalShareStatistics: { impressionCount: 444 } }] }
    })],
    [/organizationalEntityShareStatistics/, () => ({
      json: { elements: [
        { share: 'urn:li:share:9001', totalShareStatistics: { impressionCount: 3000, likeCount: 90, commentCount: 1, shareCount: 4 } },
        { ugcPost: 'urn:li:ugcPost:9002', totalShareStatistics: { impressionCount: 1000, likeCount: 20, commentCount: 0, shareCount: 1 } }
      ] }
    })],
    [/organizationalEntityFollowerStatistics/, () => ({ status: 403, json: { message: 'Not enough permissions', status: 403 } })],
    [/api\.linkedin\.com\/rest\/socialActions\//, () => ({
      json: { elements: [{ id: 'urn:li:comment:(urn:li:share:9001,55)', actor: 'urn:li:person:xyz', message: { text: 'Bravo, excellent retour !' }, created: { time: now - DAY }, likesSummary: { totalLikes: 2 } }] }
    })]
  ];
  const f = fakeFetch([...(overrides.routes || []), ...routes]);
  f.hits = hits;
  return f;
}
