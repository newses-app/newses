import type { CurrentSession } from '@newses/shared';
import { useQueryClient } from '@tanstack/vue-query';
import { onScopeDispose, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { api } from '../api.ts';
import { appNotificationStrings } from '../lib/new-entries.ts';
import {
  closeNewEntriesNotification,
  renewWebPush,
  rewordWebPush,
  webPushSupport,
} from '../offline/push.ts';
import { bridge } from '../platform/index.ts';
import { SESSION_KEY, sessionVerified } from './useSession.ts';

/**
 * Keeps the browser's notifications of new entries going: binds its subscription to this launch's
 * session, words them in the app's language, and closes the one showing once the reader is back.
 * Mount once, in the signed-in layout.
 */
export function useWebPush(): void {
  if (bridge.platform !== 'web' || webPushSupport() !== 'supported') return;
  const { t, locale } = useI18n();
  const queryClient = useQueryClient();
  const strings = () => appNotificationStrings(t, locale.value);

  watch(
    sessionVerified,
    async (verified) => {
      const session = queryClient.getQueryData<CurrentSession>(SESSION_KEY);
      if (!verified || !session) return;
      // Unreachable now: the subscription stays as it was until the next launch.
      const info = await api.serverInfo().catch(() => null);
      if (info)
        await renewWebPush(session.user.id, info.push?.key ?? null, strings()).catch(
          () => undefined,
        );
    },
    { immediate: true },
  );
  watch(locale, () => void rewordWebPush(strings()).catch(() => undefined));

  const back = () => {
    if (document.visibilityState === 'visible')
      void closeNewEntriesNotification().catch(() => undefined);
  };
  back();
  document.addEventListener('visibilitychange', back);
  onScopeDispose(() => {
    document.removeEventListener('visibilitychange', back);
  });
}
