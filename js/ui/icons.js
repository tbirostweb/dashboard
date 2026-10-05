/* Icônes SVG inline (décoratives : aria-hidden). Aucune donnée externe n'entre ici. */
import { esc } from '../core/format.js?v=17';
import { PLATFORM_LABELS } from '../core/labels.js?v=17';

const svg = (attrs, inner) => `<svg viewBox="0 0 24 24" ${attrs} aria-hidden="true" focusable="false">${inner}</svg>`;
const stroke = (w, inner) => svg(`fill="none" stroke="currentColor" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round"`, inner);

export const PLATFORM_ICONS = {
  tiktok: svg('fill="currentColor"', '<path d="M16.6 3c.4 2.2 1.8 3.7 4 3.9v3.2c-1.5 0-2.8-.4-4-1.2v6.3c0 3.3-2.6 5.8-5.8 5.8S5 18.5 5 15.2s2.6-5.8 5.8-5.8c.3 0 .6 0 .9.1v3.3a2.6 2.6 0 1 0 1.8 2.5V3z"/>'),
  instagram: stroke(2, '<rect x="3" y="3" width="18" height="18" rx="5"/><circle cx="12" cy="12" r="4"/><circle cx="17.5" cy="6.5" r="1" fill="currentColor"/>'),
  linkedin: svg('fill="currentColor"', '<path d="M4 3a2 2 0 1 1 0 4 2 2 0 0 1 0-4zM3 9h3v12H3zM9 9h3v1.7c.5-.9 1.7-1.9 3.5-1.9 3.3 0 3.5 2.2 3.5 5V21h-3v-6.2c0-1.5 0-3.1-1.9-3.1s-2.1 1.4-2.1 3V21H9z"/>')
};

/** Icônes de statut : une forme différente par famille (la couleur ne porte jamais seule l'information). */
export const STATUS_ICONS = {
  ok: stroke(2.4, '<path d="M5 12.5l4.5 4.5L19 7.5"/>'),
  warn: stroke(2.2, '<path d="M12 4l9 16H3z"/><path d="M12 10v4M12 17.2v.1"/>'),
  error: stroke(2.4, '<path d="M6 6l12 12M18 6L6 18"/>'),
  info: stroke(2.2, '<circle cx="12" cy="12" r="8.5"/><path d="M12 11v5M12 8v.1"/>'),
  neutral: stroke(2.2, '<circle cx="12" cy="12" r="8.5"/><path d="M8.5 12h7"/>'),
  pending: stroke(2.2, '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>'),
  lock: stroke(2, '<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>')
};

export const ICON = {
  heart: stroke(2, '<path d="M12 20s-7-4.4-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.6-7 10-7 10z"/>'),
  arrow: stroke(2, '<path d="M7 17L17 7M8 7h9v9"/>'),
  external: stroke(2, '<path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>'),
  refresh: stroke(2, '<path d="M20 11a8 8 0 0 0-14.5-4M4 4v4h4M4 13a8 8 0 0 0 14.5 4M20 20v-4h-4"/>'),
  download: stroke(2, '<path d="M12 4v11M7 11l5 5 5-5M5 20h14"/>'),
  info: stroke(2, '<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7.5v.1"/>'),
  up: stroke(2.2, '<path d="M7 17L17 7M9 7h8v8"/>'),
  down: stroke(2.2, '<path d="M7 7l10 10M17 9v8H9"/>'),
  flat: stroke(2.2, '<path d="M5 12h14M14 7l5 5-5 5"/>'),
  pause: stroke(2.4, '<path d="M9 6v12M15 6v12"/>'),
  offline: stroke(2.2, '<path d="M4 4l16 16M8.5 16.2a5 5 0 0 1 7 0M5 12.6a10 10 0 0 1 3-2M10.3 6.3A14 14 0 0 1 21 9.6M12 20v.1"/>'),
  live: stroke(2.2, '<circle cx="12" cy="12" r="3" fill="currentColor"/><path d="M7.5 7.5a6.4 6.4 0 0 0 0 9M16.5 7.5a6.4 6.4 0 0 1 0 9"/>'),
  image: stroke(1.8, '<rect x="3" y="4" width="18" height="16" rx="3"/><circle cx="9" cy="10" r="1.8"/><path d="M4 18l5-5 4 4 3-3 4 4"/>')
};

/** Pastille plateforme : icône + libellé (jamais la couleur seule). */
export const platformBadge = (p) => `<span class="badge badge--${esc(p)}">${PLATFORM_ICONS[p] || ''}${esc(PLATFORM_LABELS[p] || p)}</span>`;
