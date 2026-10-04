import { computed } from 'vue';
import { useI18n } from 'vue-i18n';

const INTERVALS = [15, 30, 60, 120, 240, 720, 1440, 10_080];
const PURGE_DAYS = [7, 14, 30, 60, 90, 180, 365];

/** Labels and choices for update intervals and purge ages; null means "use the default". */
export function useDurations() {
  const { t } = useI18n();

  function duration(minutes: number): string {
    if (minutes % 10_080 === 0) return t('time.weeks', { n: minutes / 10_080 }, minutes / 10_080);
    if (minutes % 1440 === 0) return t('time.days', { n: minutes / 1440 }, minutes / 1440);
    if (minutes % 60 === 0) return t('time.hours', { n: minutes / 60 }, minutes / 60);
    return t('time.minutes', { n: minutes }, minutes);
  }

  const intervalItems = computed(() => [
    { title: t('feeds.useDefault'), value: null },
    ...INTERVALS.map((minutes) => ({
      title: t('feeds.every', { duration: duration(minutes) }),
      value: minutes,
    })),
  ]);

  const purgeItems = computed(() => [
    { title: t('feeds.useDefault'), value: null },
    ...PURGE_DAYS.map((days) => ({
      title: t('feeds.olderThan', { duration: t('time.days', { n: days }, days) }),
      value: days,
    })),
    { title: t('feeds.keepForever'), value: 0 },
  ]);

  return { duration, intervalItems, purgeItems };
}
