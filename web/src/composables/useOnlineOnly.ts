import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { connectivity } from '../offline/connectivity.ts';
import { useUiStore } from '../stores/ui.ts';

/**
 * For actions that need the server: whether it can be reached now, for `aria-disabled`, and a
 * wrapper that runs the action then, and otherwise says why it cannot.
 */
export function useOnlineOnly() {
  const ui = useUiStore();
  const { t } = useI18n();
  const online = computed(() => connectivity.value === 'online');
  const whenOnline =
    <A extends unknown[]>(action: (...args: A) => unknown) =>
    (...args: A): void => {
      if (online.value) void action(...args);
      else ui.notify(t('offline.needsConnection'));
    };
  return { online, whenOnline };
}
