<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { formatRelative } from '../../lib/format.ts';
import { persisted, requestPersistence } from '../../offline/db.ts';
import {
  LIMIT_CHOICES,
  offlineSettings,
  saveSettings,
  UNREAD_CHOICES,
} from '../../offline/settings.ts';
import {
  backgroundState,
  outboxPending,
  storeSummary,
  syncRequests,
  syncStatus,
} from '../../offline/status.ts';
import {
  clearStore,
  currentStore,
  offlineEnabled,
  setOfflineEnabled,
} from '../../offline/store.ts';
import { reloadStore } from '../../offline/sync.ts';
import { bridge, NATIVE } from '../../platform/index.ts';
import { useUiStore } from '../../stores/ui.ts';

const { t, locale } = useI18n();
const ui = useUiStore();
const enabled = ref(offlineEnabled());
const kept = ref(false);
const summary = ref<Awaited<ReturnType<typeof storeSummary>> | null>(null);
const android = bridge.platform === 'android';
const desktop = bridge.platform === 'desktop';

/**
 * Syncing while closed: Android's background job, or in a browser the service worker, which only
 * installed Chrome and Edge apps get. The desktop app keeps running in the tray instead.
 */
const backgroundAvailable = computed(
  () => android || backgroundState.value === 'on' || backgroundState.value === 'off',
);
const backgroundHint = computed(() => {
  if (android) return t('offline.backgroundAndroid');
  switch (backgroundState.value) {
    case 'on':
    case 'off':
      return t('offline.backgroundInstalled');
    case 'notInstalled':
      return t('offline.backgroundInstall');
    default:
      return t('offline.backgroundUnsupported');
  }
});

/** Safari deletes a site's storage after 7 days without a visit, unless it is on the Home Screen. */
const iosBrowser =
  !NATIVE &&
  (/iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.userAgent.includes('Macintosh') && navigator.maxTouchPoints > 1)) &&
  !window.matchMedia('(display-mode: standalone)').matches;

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

const number = (n: number) => new Intl.NumberFormat(locale.value).format(n);
const size = (bytes: number) =>
  new Intl.NumberFormat(locale.value, {
    style: 'unit',
    unit: bytes >= 1e9 ? 'gigabyte' : 'megabyte',
    maximumFractionDigits: 1,
  }).format(bytes >= 1e9 ? bytes / 1e9 : bytes / 1e6);

const unreadItems = computed(() =>
  UNREAD_CHOICES.map((n) => ({ value: n, title: t('offline.keepUnread', { n: number(n) }) })),
);
const limitItems = computed(() => LIMIT_CHOICES.map((n) => ({ value: n, title: size(n) })));

async function toggle(on: boolean) {
  // Asked straight from the click: Firefox shows a prompt, which needs the user's gesture.
  if (on) kept.value = await requestPersistence();
  await setOfflineEnabled(on);
  enabled.value = on;
  if (on) syncRequests.value++;
  await refresh();
}

/** Keeping more unread articles loads the headlines again; the other changes apply at the next sync. */
async function setUnread(unread: number) {
  const more = unread > offlineSettings.unread;
  saveSettings({ unread });
  const db = currentStore();
  if (more && db) await reloadStore(db);
  syncRequests.value++;
}

function change(setting: Parameters<typeof saveSettings>[0]) {
  saveSettings(setting);
  syncRequests.value++;
}

function syncNow() {
  syncRequests.value++;
}

async function clear() {
  const pending = outboxPending.value;
  const text =
    pending > 0
      ? `${t('offline.clearText')} ${t('offline.clearPending', { n: pending }, pending)}`
      : t('offline.clearText');
  if (!(await ui.confirm(t('offline.clearTitle'), text, t('offline.clear')))) return;
  await clearStore();
  syncRequests.value++;
  await refresh();
}
</script>

<template>
  <section>
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
    <template v-if="enabled">
      <v-row class="mt-2">
        <v-col cols="12" sm="6">
          <v-select
            :model-value="offlineSettings.unread"
            :items="unreadItems"
            :label="t('offline.keep')"
            :hint="t('offline.keepHint')"
            persistent-hint
            @update:model-value="(v: number) => setUnread(v)"
          />
        </v-col>
        <v-col cols="12" sm="6">
          <v-select
            :model-value="offlineSettings.limitBytes"
            :items="limitItems"
            :label="t('offline.limit')"
            :hint="t('offline.limitHint')"
            persistent-hint
            @update:model-value="(v: number) => change({ limitBytes: v })"
          />
        </v-col>
      </v-row>
      <v-switch
        :model-value="offlineSettings.images"
        :label="t('offline.images')"
        color="primary"
        density="compact"
        hide-details
        @update:model-value="change({ images: $event === true })"
      />
      <v-switch
        v-if="backgroundAvailable"
        :model-value="offlineSettings.background"
        :label="t('offline.background')"
        :hint="backgroundHint"
        persistent-hint
        color="primary"
        density="compact"
        class="mb-2"
        @update:model-value="change({ background: $event === true })"
      />
      <p v-else-if="!desktop" class="text-body-medium text-medium-emphasis mb-2">
        {{ backgroundHint }}
      </p>
      <v-switch
        v-if="android"
        :model-value="offlineSettings.wifiOnly"
        :disabled="!offlineSettings.images"
        :label="t('offline.wifiOnly')"
        color="primary"
        density="compact"
        hide-details
        @update:model-value="change({ wifiOnly: $event === true })"
      />

      <v-list density="compact" class="my-2">
        <v-list-item v-if="summary">
          <v-list-item-title class="text-wrap">
            {{
              t('offline.stored', {
                entries: number(summary.entries),
                contents: number(summary.contents),
                images: number(summary.images),
                size: size(summary.bytes),
              })
            }}
          </v-list-item-title>
        </v-list-item>
        <v-list-item v-if="summary && summary.index > 0">
          <v-list-item-title class="text-wrap">
            {{ t('offline.searchIndex', { size: size(summary.index) }) }}
          </v-list-item-title>
        </v-list-item>
        <v-list-item v-if="outboxPending > 0">
          <v-list-item-title class="text-wrap">
            {{ t('offline.pending', { n: outboxPending }, outboxPending) }}
          </v-list-item-title>
        </v-list-item>
        <v-list-item>
          <v-list-item-title class="text-wrap">
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
        </v-list-item>
        <v-list-item v-if="!NATIVE">
          <v-list-item-title class="text-wrap text-medium-emphasis">
            {{ kept ? t('offline.persisted') : t('offline.notPersisted') }}
          </v-list-item-title>
        </v-list-item>
      </v-list>
      <v-alert v-if="iosBrowser" type="info" variant="tonal" density="compact" class="mb-4">
        {{ t('offline.homeScreen') }}
      </v-alert>
      <div class="d-flex flex-wrap ga-2">
        <v-btn variant="tonal" :loading="syncStatus.running" @click="syncNow">
          {{ t('offline.syncNow') }}
        </v-btn>
        <v-btn variant="text" color="error" @click="clear">{{ t('offline.clear') }}</v-btn>
      </div>
    </template>
  </section>
</template>
