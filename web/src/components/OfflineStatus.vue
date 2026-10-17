<script setup lang="ts">
import { mdiCloudOffOutline, mdiCloudSyncOutline, mdiCloudCheckOutline } from '@mdi/js';
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { formatRelative } from '../lib/format.ts';
import { connectivity } from '../offline/connectivity.ts';
import { outboxPending } from '../offline/outbox.ts';
import { syncStatus } from '../offline/status.ts';

const { t, locale } = useI18n();

/** Shown for a few seconds after the connection returns, so the change is noticed and announced. */
const BACK_MS = 4000;
const back = ref(false);
let backTimer: ReturnType<typeof setTimeout> | undefined;
watch(connectivity, (state, previous) => {
  clearTimeout(backTimer);
  back.value = state === 'online' && previous !== 'online';
  if (back.value)
    backTimer = setTimeout(() => {
      back.value = false;
    }, BACK_MS);
});
onBeforeUnmount(() => {
  clearTimeout(backTimer);
});

const pending = computed(() =>
  outboxPending.value > 0
    ? t('offline.pending', { n: outboxPending.value }, outboxPending.value)
    : '',
);
const synced = computed(() =>
  syncStatus.lastSyncedAt
    ? t('offline.lastSynced', {
        when: formatRelative(new Date(syncStatus.lastSyncedAt).toISOString(), locale.value),
      })
    : '',
);

/** What the status says; empty (and hidden) while online with nothing waiting. */
const status = computed(() => {
  if (connectivity.value !== 'online') {
    const state = t(connectivity.value === 'offline' ? 'offline.offline' : 'offline.unreachable');
    return { icon: mdiCloudOffOutline, text: [state, pending.value, synced.value] };
  }
  if (outboxPending.value > 0)
    return { icon: mdiCloudSyncOutline, text: [t('offline.sending'), pending.value] };
  if (back.value) return { icon: mdiCloudCheckOutline, text: [t('offline.backOnline')] };
  return null;
});
const text = computed(() => status.value?.text.filter(Boolean).join(' · ') ?? '');
</script>

<template>
  <div class="offline-status" role="status">
    <v-chip v-if="status" :prepend-icon="status.icon" variant="elevated" size="small">
      {{ text }}
    </v-chip>
  </div>
</template>

<style scoped>
.offline-status {
  position: fixed;
  inset-inline-start: 16px;
  bottom: 16px;
  z-index: 1010;
  pointer-events: none;
  max-width: calc(100vw - 32px);
}
.offline-status :deep(.v-chip) {
  pointer-events: auto;
  max-width: 100%;
}
</style>
