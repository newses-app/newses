import type { Prefs } from './prefs.ts';

export const DEFAULT_PREFS: Prefs = {
  viewMode: 'adaptive',
  sortOrder: 'newest',
  layout: 'threePane',
  theme: 'system',
  markReadOnScroll: false,
  showContentPreview: true,
  hideReadFeeds: false,
  confirmCatchUp: true,
  proxyImages: false,
  keyboardShortcuts: true,
  freshMaxAgeHours: 24,
  updateIntervalMinutes: null,
  purgeDays: null,
};
