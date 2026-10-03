// Réponses FACTICES de la Community Management API LinkedIn (formes tirées de la doc Microsoft Learn, version 202609).
// Utilisées UNIQUEMENT par les tests : jamais affichées par l'application.
import { fakeFetch, testConfig } from './helpers.js';

export const DAY = 86_400_000;
export const NOW = Date.UTC(2026, 9, 1, 10, 0, 0); // 2026-10-01 10:00 UTC
export const ORG_ID = '146243022';
export const ORG_URN = `urn:li:organization:${ORG_ID}`;
export const LI_TOKEN = 'AQfake-linkedin-access-token-0123456789abcdefghijklmnopqrstuvwxyz';
export const FEED_SCOPES = 'r_organization_social rw_organization_admin r_organization_social_feed';

export function liConfig(extra = {}, linkedin = {}) {
  const cfg = testConfig({ LINKEDIN_ORGANIZATION_ID: ORG_ID, LINKEDIN_COMMUNITY_API: 'true', ...extra });
  Object.assign(cfg.linkedin, linkedin);
  return cfg;
}

export const orgResponse = (admin = true) => ({
  id: Number(ORG_ID), localizedName: 'Studio Test SAS', vanityName: 'studio-test', logoV2: { original: 'urn:li:digitalmediaAsset:X' },
  localizedWebsite: 'https://studio-test.example', primaryOrganizationType: 'COMPANY',
  ...(admin ? { localizedDescription: 'Agence factice.', staffCountRange: 'SIZE_11_50', industries: ['urn:li:industry:96'], localizedSpecialties: ['Web'], foundedOn: { year: 2019 } } : {})
});

export const followerSeries = (now = NOW) => {
  const end = Math.floor(now / DAY) * DAY - 2 * DAY;
  return { elements: [
    { timeRange: { start: end - 2 * DAY, end: end - DAY }, followerGains: { organicFollowerGain: 3, paidFollowerGain: 1 } },
    { timeRange: { start: end - DAY, end }, followerGains: { organicFollowerGain: 5, paidFollowerGain: 0 } }
  ] };
};

export const followerFacets = () => ({ elements: [{
  organizationalEntity: ORG_URN,
  followerCountsByAssociationType: [{ associationType: 'EMPLOYEE', followerCounts: { organicFollowerCount: 12, paidFollowerCount: 0 } }],
  followerCountsByGeoCountry: Array.from({ length: 120 }, (_, i) => ({ geo: `urn:li:geo:${i}`, followerCounts: { organicFollowerCount: i + 1, paidFollowerCount: 0 } })),
  followerCountsByGeo: [{ geo: 'urn:li:geo:90009659', followerCounts: { organicFollowerCount: 40, paidFollowerCount: 2 } }],
  followerCountsByFunction: [{ function: 'urn:li:function:8', followerCounts: { organicFollowerCount: 30, paidFollowerCount: 1 } }],
  followerCountsBySeniority: [{ seniority: 'urn:li:seniority:5', followerCounts: { organicFollowerCount: 22, paidFollowerCount: 0 } }],
  followerCountsByIndustry: [{ industry: 'urn:li:industry:96', followerCounts: { organicFollowerCount: 18, paidFollowerCount: 0 } }],
  followerCountsByStaffCountRange: [{ staffCountRange: 'SIZE_11_50', followerCounts: { organicFollowerCount: 9, paidFollowerCount: 0 } }]
}] });

export const pageStatsCumul = () => ({ elements: [{
  organization: ORG_URN,
  pageStatisticsByGeoCountry: [
    { geo: 'urn:li:geo:101174742', pageStatistics: { views: { allPageViews: { pageViews: 50, uniquePageViews: 40 } } } },
    { geo: 'urn:li:geo:105015875', pageStatistics: { views: { allPageViews: { pageViews: 80, uniquePageViews: 60 } } } }
  ],
  pageStatisticsByFunction: [{ function: 'urn:li:function:8', pageStatistics: { views: { allPageViews: { pageViews: 33 } } } }],
  totalPageStatistics: {
    clicks: { mobileCustomButtonClickCounts: [{ customButtonType: 'VISIT_WEBSITE', count: 4 }], desktopCustomButtonClickCounts: [{ customButtonType: 'VISIT_WEBSITE', count: 9 }] },
    views: {
      allPageViews: { pageViews: 300, uniquePageViews: 200 }, allDesktopPageViews: { pageViews: 180 }, allMobilePageViews: { pageViews: 120 },
      overviewPageViews: { pageViews: 150 }, careersPageViews: { pageViews: 60 }, jobsPageViews: { pageViews: 40 }, lifeAtPageViews: { pageViews: 25 }
    }
  }
}] });

export const pageStatsSeries = (now = NOW, gran = 'DAY') => ({ elements: [
  { timeRange: { start: now - 3 * DAY, end: now - 2 * DAY }, totalPageStatistics: { views: { allPageViews: { pageViews: 11, uniquePageViews: 7 } } } },
  { timeRange: { start: now - 2 * DAY, end: now - DAY }, totalPageStatistics: { views: { allPageViews: { pageViews: 13, uniquePageViews: 9 } } } }
], gran });

export const mkPost = (n, ageDays, extra = {}, now = NOW) => ({
  id: `urn:li:share:${n}`, commentary: `Publication ${n}`, publishedAt: now - ageDays * DAY, lastModifiedAt: now - ageDays * DAY, lifecycleState: 'PUBLISHED', ...extra
});

export const shareStat = (id, t) => ({ [id.includes('ugcPost') ? 'ugcPost' : 'share']: id, totalShareStatistics: t });
export const socialMeta = () => ({
  reactionSummaries: { LIKE: { reactionType: 'LIKE', count: 7 }, PRAISE: { reactionType: 'PRAISE', count: 2 }, EMPATHY: { reactionType: 'EMPATHY', count: 1 } },
  commentSummary: { count: 3, topLevelCount: 2 }
});

const isSeries = (url) => /timeIntervals/.test(url);

/** Routes LinkedIn nominales ; `over` : [[matcher, handler], …] prioritaires. */
export function linkedinFetch({ now = NOW, posts = [mkPost(1, 3), mkPost(2, 10, { id: 'urn:li:ugcPost:2' })], over = [], shareStats } = {}) {
  const f = fakeFetch([
    ...over,
    [/rest\/organizations\//, () => ({ json: orgResponse() })],
    [/rest\/networkSizes\//, () => ({ json: { firstDegreeSize: 321 } })],
    [/rest\/posts\?/, () => ({ json: { elements: posts } })],
    [(u) => /organizationalEntityFollowerStatistics/.test(u) && isSeries(u), () => ({ json: followerSeries(now) })],
    [/organizationalEntityFollowerStatistics/, () => ({ json: followerFacets() })],
    [(u) => /organizationPageStatistics/.test(u) && isSeries(u), (u) => ({ json: pageStatsSeries(now, /MONTH/.test(u) ? 'MONTH' : 'DAY') })],
    [/organizationPageStatistics/, () => ({ json: pageStatsCumul() })],
    [(u) => /organizationalEntityShareStatistics/.test(u) && isSeries(u), () => ({ json: { elements: [{ timeRange: { start: now - DAY, end: now }, totalShareStatistics: { impressionCount: 55 } }] } })],
    [/organizationalEntityShareStatistics/, (u) => ({ json: { elements: shareStats ? shareStats(u) : [
      shareStat('urn:li:share:1', { impressionCount: 1000, uniqueImpressionsCount: 800, clickCount: 50, likeCount: 40, commentCount: 3, shareCount: 2, engagement: 0.095 })
    ] } })],
    [/rest\/socialMetadata\//, () => ({ json: socialMeta() })],
    [/rest\/socialActions\//, () => ({ json: { elements: [{ id: 'urn:li:comment:(urn:li:share:1,5)', actor: 'urn:li:person:xyz', message: { text: 'Super' }, created: { time: now - DAY }, likesSummary: { totalLikes: 1 } }] } })]
  ]);
  return f;
}
export const resp = (status, json = { message: 'x', status }) => () => ({ status, json });
