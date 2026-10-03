import { createTikTokProvider } from './tiktok.js';
import { createInstagramProvider } from './instagram.js';
import { createLinkedInProvider } from './linkedin.js';

export const PLATFORMS = ['tiktok', 'instagram', 'linkedin'];
export const LABELS = { tiktok: 'TikTok', instagram: 'Instagram', linkedin: 'LinkedIn' };

export function createProviders(cfg, deps = {}) {
  return {
    tiktok: createTikTokProvider(cfg, deps),
    instagram: createInstagramProvider(cfg, deps),
    linkedin: createLinkedInProvider(cfg, deps)
  };
}
