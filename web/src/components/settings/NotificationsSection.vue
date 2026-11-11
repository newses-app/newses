<script setup lang="ts">
import type { NotificationAccess } from '@newses/shared';
import { computed, onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { offlineSettings, saveSettings } from '../../offline/settings.ts';
import { syncRequests } from '../../offline/status.ts';
import { offlineEnabled } from '../../offline/store.ts';
import { bridge, desktop } from '../../platform/index.ts';

const { t } = useI18n();
const android = bridge.platform === 'android';
const desktopOptions = computed(() => desktop.options.value);

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
  <template v-if="desktopOptions || android">
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
    </div>
  </template>
</template>
