<script setup lang="ts">
import type { NotificationAccess } from '@newses/shared';
import { useQuery } from '@tanstack/vue-query';
import { computed, onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { api } from '../../api.ts';
import { useSession } from '../../composables/useSession.ts';
import { appNotificationStrings } from '../../lib/new-entries.ts';
import {
  disableWebPush,
  enableWebPush,
  type WebPushState,
  webPushState,
  webPushSupport,
} from '../../offline/push.ts';
import { offlineSettings, saveSettings } from '../../offline/settings.ts';
import { syncRequests } from '../../offline/status.ts';
import { offlineEnabled } from '../../offline/store.ts';
import { bridge, desktop } from '../../platform/index.ts';
import { useUiStore } from '../../stores/ui.ts';

const { t, locale } = useI18n();
const ui = useUiStore();
const { session } = useSession();
const android = bridge.platform === 'android';
const desktopOptions = computed(() => desktop.options.value);

/** In a browser, the server pushes new entries (API 1.11), where the browser takes them. */
const support = bridge.platform === 'web' ? webPushSupport() : 'unsupported';
const serverInfo = useQuery({
  queryKey: ['server-info'],
  queryFn: () => api.serverInfo(),
  staleTime: Infinity,
  enabled: support !== 'unsupported',
});
const pushKey = computed(() => serverInfo.data.value?.push?.key ?? null);
const browser = computed(() => support !== 'unsupported' && pushKey.value !== null);
const browserState = ref<WebPushState>('off');
const browserBusy = ref(false);
onMounted(async () => {
  const userId = session.value?.user.id;
  if (support === 'supported' && userId !== undefined)
    browserState.value = await webPushState(userId).catch(() => 'off' as const);
});
const browserHint = computed(() => {
  if (support === 'needsInstall') return t('notifications.browserInstall');
  if (browserState.value === 'denied') return t('notifications.browserDenied');
  return t('notifications.browserHint');
});

async function setBrowser(on: boolean) {
  const userId = session.value?.user.id;
  const key = pushKey.value;
  if (userId === undefined || !key) return;
  browserBusy.value = true;
  try {
    if (on)
      browserState.value = await enableWebPush(
        userId,
        key,
        appNotificationStrings(t, locale.value),
      );
    else {
      await disableWebPush();
      browserState.value = 'off';
    }
  } catch {
    ui.notify(t('notifications.browserFailed'), true);
    browserState.value = await webPushState(userId).catch(() => 'off' as const);
  } finally {
    browserBusy.value = false;
  }
}

/** Android's notifications come from the background job, so they need it. */
const background = ref(offlineEnabled() && offlineSettings.background);
const access = ref<NotificationAccess | null>(null);
onMounted(async () => {
  if (android) access.value = await bridge.notificationAccess(false);
});

const androidOn = computed(
  () => background.value && offlineSettings.notify && access.value === 'granted',
);
const androidHint = computed(() => {
  if (!background.value) return t('notifications.needsBackground');
  if (access.value === 'denied') return t('notifications.denied');
  return t('notifications.androidHint');
});

/** Turning them on asks for the permission first; refused, they stay off and say so. */
async function setAndroid(on: boolean) {
  if (on) {
    access.value = await bridge.notificationAccess(true);
    if (access.value !== 'granted') return;
  }
  saveSettings({ notify: on });
  syncRequests.value++;
}
</script>

<template>
  <template v-if="desktopOptions || android || browser">
    <h2 class="text-title-large mb-2">{{ t('notifications.heading') }}</h2>
    <div class="mb-6">
      <v-switch
        v-if="desktopOptions"
        :model-value="desktopOptions.notifications"
        :label="t('desktop.notifications')"
        color="primary"
        density="compact"
        hide-details
        @update:model-value="desktop.set({ notifications: $event === true })"
      />
      <v-switch
        v-if="android"
        :model-value="androidOn"
        :disabled="!background"
        :label="t('notifications.android')"
        :hint="androidHint"
        persistent-hint
        color="primary"
        density="compact"
        @update:model-value="setAndroid($event === true)"
      />
      <v-switch
        v-if="browser"
        :model-value="browserState === 'on'"
        :disabled="support !== 'supported' || browserState === 'denied'"
        :loading="browserBusy"
        :label="t('notifications.browser')"
        :hint="browserHint"
        persistent-hint
        color="primary"
        density="compact"
        @update:model-value="setBrowser($event === true)"
      />
    </div>
  </template>
</template>
