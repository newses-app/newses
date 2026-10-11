import type { Counters } from '@rss-reader/shared';
import { watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { newEntries } from '../lib/new-entries.ts';
import { bridge, desktop } from '../platform/index.ts';
import { pollInBackground, useCounters } from './useCounters.ts';
import { useCategories, useSubscriptions } from './useFeeds.ts';

/** Places named in a notification before "and N more". */
const PLACES = 3;

/**
 * Desktop notifications for new entries while the window is in the background: one summary per
 * counters refresh. Mount once, in the signed-in layout.
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

  let previous: Counters | null = null;
  watch(
    () => counters.data.value,
    (next) => {
      if (!next) return;
      const before = previous;
      previous = next;
      if (!before || !enabled() || (!document.hidden && document.hasFocus())) return;
      const found = newEntries(
        before,
        next,
        subscriptions.data.value ?? [],
        categories.data.value ?? [],
      );
      if (!found) return;
      const more = found.places.length - PLACES;
      const places = found.places.slice(0, PLACES).join(', ');
      void bridge.notify({
        title: t('notifications.title', { n: found.count }, found.count),
        body: more > 0 ? t('notifications.more', { places, n: more }) : places,
        target: found.target,
      });
    },
  );
}
