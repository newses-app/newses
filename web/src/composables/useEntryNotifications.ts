import type { Counters } from '@newses/shared';
import { onScopeDispose, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { awayNotifier, newEntries } from '../lib/new-entries.ts';
import { bridge, desktop } from '../platform/index.ts';
import { pollInBackground, useCounters } from './useCounters.ts';
import { useCategories, useSubscriptions } from './useFeeds.ts';

/** Places named in a notification before "and N more". */
const PLACES = 3;
/** The running total shows again at most this often while the window is in the background. */
export const NOTIFY_GAP_MS = 15 * 60_000;

/**
 * Desktop notifications for new entries while the window is in the background: one running total
 * since it went there, replacing the last. Mount once, in the signed-in layout.
 */
export function useEntryNotifications(): void {
  if (bridge.platform !== 'desktop') return;
  const { t } = useI18n();
  const counters = useCounters();
  const subscriptions = useSubscriptions();
  const categories = useCategories();
  const enabled = () => desktop.options.value?.notifications ?? false;

  watch(
    enabled,
    (on) => {
      pollInBackground.value = on;
    },
    { immediate: true },
  );

  const notifier = awayNotifier({
    find: (since, latest) =>
      newEntries(since, latest, subscriptions.data.value ?? [], categories.data.value ?? []),
    show: (found) => {
      const more = found.places.length - PLACES;
      const places = found.places.slice(0, PLACES).join(', ');
      void bridge.notify({
        title: t('notifications.title', { n: found.count }, found.count),
        body: more > 0 ? t('notifications.more', { places, n: more }) : places,
        target: found.target,
      });
    },
    gapMs: NOTIFY_GAP_MS,
  });
  const away = () => document.hidden || !document.hasFocus();
  const comeBack = () => {
    if (!away()) notifier.back();
  };
  window.addEventListener('focus', comeBack);
  document.addEventListener('visibilitychange', comeBack);
  onScopeDispose(() => {
    window.removeEventListener('focus', comeBack);
    document.removeEventListener('visibilitychange', comeBack);
    notifier.back();
  });

  let previous: Counters | null = null;
  watch(
    () => counters.data.value,
    (next) => {
      if (!next) return;
      const before = previous;
      previous = next;
      if (!enabled() || !away()) notifier.back();
      else if (before) notifier.reading(before, next);
    },
  );
}
