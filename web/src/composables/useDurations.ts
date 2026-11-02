import { computed } from 'vue';
import { useI18n } from 'vue-i18n';

const INTERVALS = [15, 30, 60, 120, 240, 720, 1440, 10_080];
const PURGE_DAYS = [7, 14, 30, 60, 90, 180, 365];

/** A length of time in the largest unit that divides it. */
function inUnits(minutes: number): ['weeks' | 'days' | 'hours' | 'minutes', number] {
  if (minutes % 10_080 === 0) return ['weeks', minutes / 10_080];
  if (minutes % 1440 === 0) return ['days', minutes / 1440];
  if (minutes % 60 === 0) return ['hours', minutes / 60];
  return ['minutes', minutes];
}

/** Labels and choices for update intervals and purge ages; null means "use the default". */
export function useDurations() {
  const { t } = useI18n();

  function duration(minutes: number): string {
    const [unit, n] = inUnits(minutes);
    return t(`time.${unit}`, { n }, n);
  }

  function every(minutes: number): string {
    const [unit, n] = inUnits(minutes);
    const keys = {
      weeks: 'feeds.everyWeeks',
      days: 'feeds.everyDays',
      hours: 'feeds.everyHours',
      minutes: 'feeds.everyMinutes',
    };
    return t(keys[unit], { n }, n);
  }

  const intervalItems = computed(() => [
    { title: t('feeds.useDefault'), value: null },
    ...INTERVALS.map((minutes) => ({
      title: every(minutes),
      value: minutes,
    })),
  ]);

  const purgeItems = computed(() => [
    { title: t('feeds.useDefault'), value: null },
    ...PURGE_DAYS.map((days) => ({
      title: t('feeds.olderThan', { n: days }, days),
      value: days,
    })),
    { title: t('feeds.keepForever'), value: 0 },
  ]);

  return { duration, intervalItems, purgeItems };
}
