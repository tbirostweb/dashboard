// Données fournisseur SIMULÉES pour les tests d'intégration (aucun réseau). Les valeurs « CANARY » ne doivent
// jamais apparaître dans une réponse de l'API.
export const DAY = 86_400_000;
export const CANARY = {
  access: 'CANARY-ACCESS-TOKEN-7f3a91',
  refresh: 'CANARY-REFRESH-TOKEN-b21c04',
  state: 'CANARY-OAUTH-STATE-5d8e22',
  key: 'PUBLIC_TEST_PLACEHOLDER_1',
  comment: 'CANARY-COMMENT-LINKEDIN-TEXT'
};

export const iso = (t, offsetDays = 0) => new Date(t - offsetDays * DAY).toISOString();

export function tiktokRaw(t) {
  return {
    account: { platform: 'tiktok', name: 'Studio', handle: '@studio', url: 'https://www.tiktok.com/@studio' },
    followers: 1000,
    posts: [
      { id: 'tt-1', platform: 'tiktok', type: 'Vidéo courte', title: 'Récente', publishedAt: iso(t, 2), views: 1000, likes: 50, comments: 10, shares: 5, saves: null, url: 'https://www.tiktok.com/@studio/video/1', coverUrl: 'https://p16-sign.tiktokcdn-eu.com/obj/cover1.jpeg?x-expires=1&sig=abc', durationSeconds: 20, durationBucket: '15–30 s', engagementRate: 0.065, accessToken: CANARY.access },
      { id: 'tt-2', platform: 'tiktok', type: 'Vidéo longue', title: 'Précédente', publishedAt: iso(t, 45), views: 500, likes: 20, comments: 0, shares: 0, saves: null, url: 'javascript:alert(1)', coverUrl: 'http://p16.tiktokcdn.com/insecure.jpeg', durationSeconds: 90, durationBucket: '> 60 s', engagementRate: 0.04 }
    ],
    comments: null,
    notes: ['Commentaires non disponibles pour TikTok.'],
    details: {
      imageUrlsExpire: true,
      profile: { username: 'studio', displayName: 'Studio', bio: 'Bio', isVerified: false, avatarUrl: 'https://p16-sign.tiktokcdn-us.com/avatar.jpeg?sig=1', profileDeepLink: 'https://www.tiktok.com/@studio', followerCount: 1000, followingCount: 5, likesCount: 99, videoCount: 2, accessToken: CANARY.access },
      coverage: { videosFetched: 2, windowDays: 190, maxPages: 5, truncated: false },
      cadence: { postsPerWeek: 0.5, lastPostAt: iso(t, 2) },
      notes: ['note'],
      refreshToken: CANARY.refresh,
      internal: { secret: CANARY.key }
    }
  };
}

export function instagramRaw(t) {
  return {
    account: { platform: 'instagram', name: 'Studio IG', handle: '@studio.ig', url: 'https://www.instagram.com/studio.ig' },
    followers: 2000,
    posts: [
      { id: 'ig-1', platform: 'instagram', type: 'Reel', title: 'Reel', publishedAt: iso(t, 3), views: 2000, likes: 100, comments: 20, shares: 10, saves: 30, url: 'https://www.instagram.com/reel/1/', thumbnailUrl: 'https://scontent-cdg4-1.cdninstagram.com/v/t51/a.jpg?sig=1', imageUrlsExpire: true, productType: 'REELS', reach: 2000, viewsCount: 3500, reposts: 2, totalInteractions: 160, profileVisits: 12, follows: 3, avgWatchTimeSeconds: 4.2, totalWatchTimeSeconds: 900, skipRate: 0.31 },
      { id: 'ig-2', platform: 'instagram', type: 'Image', title: 'Sans insights', publishedAt: iso(t, 5), views: 400, likes: 10, comments: 1, shares: 0, saves: null, url: 'https://www.instagram.com/p/2/', thumbnailUrl: 'https://evil.example.com/a.jpg', productType: 'FEED', reach: null, viewsCount: null, reposts: null, totalInteractions: null, profileVisits: null, follows: null, avgWatchTimeSeconds: null, totalWatchTimeSeconds: null, skipRate: null }
    ],
    comments: [],
    dailyViews: {}, dailyNewFollowers: {},
    notes: [],
    details: {
      profile: { username: 'studio.ig', name: 'Studio IG', accountType: 'BUSINESS', biography: 'Bio', website: 'https://example.test', profilePictureUrl: 'https://scontent.cdninstagram.com/p.jpg?sig=2', followersCount: 2000, followsCount: 10, mediaCount: 2, imageUrlsExpire: true, token: CANARY.access },
      reels: { count: 1, avgWatchTimeSeconds: 4.2, totalWatchTimeSeconds: 900, skipRate: 0.31 },
      coverage: { mediaFetched: 2, insightsFetchedFor: 1, commentsFetchedFor: 0, truncated: false, windowDays: 190 },
      imageUrlsExpire: true,
      notes: ['n1'],
      debugDump: { accessToken: CANARY.access }
    }
  };
}

export function linkedinRaw(t, { budget = { used: 10, limit: 80, resetsAt: iso(t, -1) }, blocks = {}, comments = true } = {}) {
  const ok = { state: 'ok', reason: null };
  return {
    account: { platform: 'linkedin', name: 'Studio SAS', handle: 'studio-sas', url: 'https://www.linkedin.com/company/studio-sas/' },
    followers: 300,
    posts: [
      { id: 'li-9001', platform: 'linkedin', type: 'Document', title: 'Étude', publishedAt: iso(t, 4), views: 3000, likes: 90, comments: 1, shares: 4, saves: 0, url: 'https://www.linkedin.com/feed/update/urn:li:share:9001/', impressions: 3000, uniqueImpressions: 2000, clicks: 40, reactions: 90, engagementRate: 4.5, measured: true, sponsored: false, reactionsByType: { LIKE: 80, PRAISE: 10 } },
      { id: 'li-9002', platform: 'linkedin', type: 'Texte', title: 'Non mesurée', publishedAt: iso(t, 6), views: 0, likes: 0, comments: 0, shares: 0, saves: 0, url: 'https://www.linkedin.com/feed/update/urn:li:share:9002/', impressions: null, uniqueImpressions: null, clicks: null, reactions: null, engagementRate: null, measured: false, sponsored: false, reactionsByType: null }
    ],
    comments: comments ? [{ id: 'li-c-1', platform: 'linkedin', postId: 'li-9001', author: 'Membre LinkedIn', handle: 'Membre', text: CANARY.comment, sentiment: 'neutral', likes: 0, createdAt: iso(t, 1) }] : [],
    dailyViews: {}, dailyNewFollowers: {},
    commentsRetentionHours: 48,
    notes: [],
    details: {
      organization: { name: 'Studio SAS', vanityName: 'studio-sas', website: null, description: null, staffCountRange: 'SIZE_11_50', industries: ['urn:li:industry:4'], foundedOn: { year: 2020 }, type: 'PRIVATELY_HELD', ...ok },
      followers: { total: 300, gains: [{ date: iso(t, 3).slice(0, 10), organic: 2, paid: 0 }], facets: { association: null, country: [{ key: 'urn:li:geo:101', count: 120 }], function: null, seniority: null, industry: null, staffCount: null, region: null }, facetsTopN: 100, latestDataDate: iso(t, 3).slice(0, 10), ...ok },
      pageStats: { daily: [{ date: iso(t, 3).slice(0, 10), pageViews: 20, uniqueVisitors: 12 }], bySection: { overview: 10, careers: null, jobs: null, lifeAt: null }, byDevice: { desktop: 12, mobile: 8 }, total: { pageViews: 20, uniquePageViews: 12 }, clicks: { desktop: null, mobile: null }, window: { start: '2026-07-01', end: '2026-09-30', granularity: 'DAY' }, ...ok },
      reactionsByType: { LIKE: 80, PRAISE: 10 },
      reactionLabels: { LIKE: 'J’aime', PRAISE: 'Bravo' },
      coverage: { postsFetched: 2, organicPosts: 2, sponsoredExcluded: 0, truncated: false, statsMeasuredFor: 1, windowMonths: 12 },
      sponsoredPosts: [],
      blocks: { organization: ok, followers: ok, pageStats: ok, posts: ok, postStats: ok, dailyImpressions: ok, reactions: ok, comments: ok, ...blocks },
      budget,
      retention: { commentsHours: 48 },
      notes: [],
      secretState: CANARY.state
    }
  };
}
