<script setup lang="ts">
import { onMounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { formatRelative } from '../../lib/format.ts';
import { persisted, requestPersistence } from '../../offline/db.ts';
import { storeSummary, syncRequests, syncStatus } from '../../offline/status.ts';
import { currentStore, offlineEnabled, setOfflineEnabled } from '../../offline/store.ts';
import { NATIVE } from '../../platform/index.ts';

const { t, locale } = useI18n();
const enabled = ref(offlineEnabled());
const kept = ref(false);
const summary = ref<Awaited<ReturnType<typeof storeSummary>> | null>(null);

async function refresh() {
  const db = currentStore();
  summary.value = db ? await storeSummary(db).catch(() => null) : null;
  kept.value = await persisted();
}
onMounted(() => void refresh());
watch(
  () => syncStatus.running,
  (running) => {
    if (!running) void refresh();
  },
);

const size = (bytes: number) =>
  new Intl.NumberFormat(locale.value, {
    style: 'unit',
    unit: 'megabyte',
    maximumFractionDigits: 1,
  }).format(bytes / 1_000_000);

async function toggle(on: boolean) {
  // Asked straight from the click: Firefox shows a prompt, which needs the user's gesture.
  if (on) kept.value = await requestPersistence();
  await setOfflineEnabled(on);
  enabled.value = on;
  if (on) syncRequests.value++;
  await refresh();
}

function syncNow() {
  syncRequests.value++;
}
</script>

<template>
  <h2 class="text-title-large mb-2">{{ t('offline.title') }}</h2>
  <v-switch
    v-if="!NATIVE"
    :model-value="enabled"
    :label="t('offline.enable')"
    color="primary"
    density="compact"
    hide-details
    @update:model-value="toggle($event === true)"
  />
  <v-list v-if="enabled" density="compact" class="mb-2">
    <v-list-item v-if="summary">
      <v-list-item-title class="text-wrap">
        {{
          t('offline.stored', {
            entries: summary.entries,
            contents: summary.contents,
            images: summary.images,
            size: size(summary.bytes),
          })
        }}
      </v-list-item-title>
    </v-list-item>
    <v-list-item>
      <v-list-item-title class="text-wrap" role="status">
        <template v-if="syncStatus.unsupported">{{ t('offline.unsupported') }}</template>
        <template v-else-if="syncStatus.running">{{ t('offline.syncing') }}</template>
        <template v-else-if="syncStatus.lastSyncedAt">
          {{
            t('offline.lastSynced', {
              when: formatRelative(new Date(syncStatus.lastSyncedAt).toISOString(), locale),
            })
          }}
        </template>
        <template v-else>{{ t('offline.neverSynced') }}</template>
      </v-list-item-title>
      <v-list-item-subtitle v-if="syncStatus.lastError" class="text-wrap">
        {{ t('offline.lastError', { error: syncStatus.lastError }) }}
      </v-list-item-subtitle>
      <v-btn
        class="mt-2"
        variant="tonal"
        size="small"
        :loading="syncStatus.running"
        @click="syncNow"
      >
        {{ t('offline.syncNow') }}
      </v-btn>
    </v-list-item>
    <v-list-item v-if="!NATIVE">
      <v-list-item-title class="text-wrap text-medium-emphasis">
        {{ kept ? t('offline.persisted') : t('offline.notPersisted') }}
      </v-list-item-title>
    </v-list-item>
  </v-list>
</template>
