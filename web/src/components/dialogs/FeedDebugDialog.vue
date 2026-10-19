<script setup lang="ts">
import type { FeedDebug, Filter } from '@newses/shared';
import { useQuery } from '@tanstack/vue-query';
import { computed, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { api, ApiError } from '../../api.ts';
import { useOnlineOnly } from '../../composables/useOnlineOnly.ts';
import { useReturnFocus } from '../../composables/useReturnFocus.ts';
import { useSubscriptions } from '../../composables/useFeeds.ts';
import { formatDateTime } from '../../lib/format.ts';
import { useUiStore } from '../../stores/ui.ts';

/** The feed debugger: what the feed answers now, and what would be stored, without storing it. */
const ui = useUiStore();
const { t, locale } = useI18n();
const { online } = useOnlineOnly();
const subscriptions = useSubscriptions();

const open = computed({
  get: () => ui.debugSubscriptionId !== null,
  set: (value) => {
    if (!value) ui.debugSubscriptionId = null;
  },
});
const restoreFocus = useReturnFocus(() => open.value);
const subscription = computed(() =>
  subscriptions.data.value?.find((s) => s.id === ui.debugSubscriptionId),
);

const filters = useQuery({
  queryKey: ['filters'],
  queryFn: () => api.filters.list(),
  enabled: open,
});
const filterNames = computed(
  () => new Map((filters.data.value ?? []).map((f: Filter) => [f.id, f.title])),
);

const result = ref<FeedDebug | null>(null);
const failure = ref<string | null>(null);
const busy = ref(false);

async function run() {
  const id = ui.debugSubscriptionId;
  if (id === null) return;
  if (!online.value) {
    failure.value = t('offline.needsConnection');
    return;
  }
  busy.value = true;
  failure.value = null;
  try {
    result.value = await api.subscriptions.debug(id);
  } catch (error) {
    result.value = null;
    failure.value = error instanceof ApiError ? error.message : t('errors.generic');
  } finally {
    busy.value = false;
  }
}

watch(
  () => ui.debugSubscriptionId,
  (id) => {
    result.value = null;
    failure.value = null;
    if (id !== null) void run();
  },
);

const bytes = (value: number) =>
  new Intl.NumberFormat(locale.value, {
    style: 'unit',
    unit: value >= 1e6 ? 'megabyte' : 'kilobyte',
    maximumFractionDigits: 1,
  }).format(value >= 1e6 ? value / 1e6 : value / 1e3);
</script>

<template>
  <v-dialog v-model="open" max-width="760" scrollable @after-leave="restoreFocus">
    <v-card :title="t('feedDebug.title')" :subtitle="subscription?.url ?? result?.url ?? ''">
      <v-card-text>
        <v-progress-linear v-if="busy" indeterminate :aria-label="t('common.loading')" />
        <v-alert v-if="failure" type="error" variant="tonal" density="compact">
          {{ failure }}
        </v-alert>
        <template v-if="result">
          <v-alert
            v-if="result.error"
            type="warning"
            variant="tonal"
            density="compact"
            class="mb-4"
          >
            {{ result.error.message }}
            <template v-if="result.error.retryAfterSeconds">
              {{ t('feedDebug.retryAfter', { seconds: result.error.retryAfterSeconds }) }}
            </template>
          </v-alert>

          <template v-if="result.response">
            <h3 class="text-title-small">{{ t('feedDebug.response') }}</h3>
            <p class="text-body-medium">
              {{
                t('feedDebug.status', {
                  status: result.response.status,
                  type: result.response.contentType ?? t('feedDebug.noType'),
                  size: bytes(result.response.bytes),
                })
              }}
            </p>
            <p v-if="result.response.url !== result.url" class="text-body-small">
              {{ t('feedDebug.redirected', { url: result.response.url }) }}
            </p>
            <p v-if="result.response.permanentUrl" class="text-body-small">
              {{ t('feedDebug.moved', { url: result.response.permanentUrl }) }}
            </p>
            <v-expansion-panels variant="accordion" class="my-2">
              <v-expansion-panel :title="t('feedDebug.headers')">
                <v-expansion-panel-text>
                  <v-table density="compact">
                    <tbody>
                      <tr v-for="header in result.response.headers" :key="header.name">
                        <th scope="row" class="text-no-wrap">{{ header.name }}</th>
                        <td class="debug-text">{{ header.value }}</td>
                      </tr>
                    </tbody>
                  </v-table>
                </v-expansion-panel-text>
              </v-expansion-panel>
              <v-expansion-panel :title="t('feedDebug.body')">
                <v-expansion-panel-text>
                  <p v-if="result.response.truncated" class="text-body-small mb-2">
                    {{ t('feedDebug.truncated') }}
                  </p>
                  <pre class="debug-text debug-body">{{ result.response.body }}</pre>
                </v-expansion-panel-text>
              </v-expansion-panel>
            </v-expansion-panels>
          </template>

          <template v-if="result.feed || result.parseError">
            <h3 class="text-title-small mt-4">{{ t('feedDebug.parsed') }}</h3>
            <p v-if="result.feed" class="text-body-medium">
              {{
                t('feedDebug.feed', {
                  format: result.feed.format.toUpperCase(),
                  title: result.feed.title ?? t('entries.untitled'),
                  n: result.entries.length,
                })
              }}
            </p>
            <v-alert v-else type="warning" variant="tonal" density="compact">
              {{ t('feedDebug.parseError', { error: result.parseError }) }}
            </v-alert>
            <template v-if="result.discovered.length > 0">
              <p class="text-body-small mt-2">{{ t('feedDebug.discovered') }}</p>
              <ul class="ms-4">
                <li v-for="candidate in result.discovered" :key="candidate.url" class="debug-text">
                  {{ candidate.title ? `${candidate.title}: ` : '' }}{{ candidate.url }}
                </li>
              </ul>
            </template>
          </template>

          <v-list v-if="result.entries.length > 0" density="compact" class="mt-2">
            <v-list-item v-for="entry in result.entries" :key="entry.guid">
              <v-list-item-title>{{ entry.title ?? t('entries.untitled') }}</v-list-item-title>
              <v-list-item-subtitle>
                <template v-if="entry.publishedAt">
                  {{ formatDateTime(entry.publishedAt, locale) }} ·
                </template>
                {{ entry.link ?? entry.guid }}
              </v-list-item-subtitle>
              <div class="d-flex flex-wrap ga-1 mt-1">
                <v-chip v-for="tag in entry.tags" :key="`tag:${tag}`" size="x-small">
                  {{ tag }}
                </v-chip>
                <v-chip
                  v-for="id in entry.filterIds"
                  :key="`filter:${String(id)}`"
                  size="x-small"
                  color="primary"
                >
                  {{ t('feedDebug.filter', { name: filterNames.get(id) ?? `#${String(id)}` }) }}
                </v-chip>
              </div>
            </v-list-item>
          </v-list>
        </template>
      </v-card-text>
      <v-card-actions>
        <v-btn :loading="busy" :aria-disabled="!online" @click="run">
          {{ t('feedDebug.again') }}
        </v-btn>
        <v-spacer />
        <v-btn @click="open = false">{{ t('common.close') }}</v-btn>
      </v-card-actions>
    </v-card>
  </v-dialog>
</template>

<style scoped>
.debug-text {
  font-family: ui-monospace, monospace;
  overflow-wrap: anywhere;
}
.debug-body {
  max-height: 24rem;
  overflow: auto;
  white-space: pre-wrap;
}
</style>
