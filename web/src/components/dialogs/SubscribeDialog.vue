<script setup lang="ts">
import type { FeedCandidate } from '@rss-reader/shared';
import { ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { useRouter } from 'vue-router';
import { api, ApiError } from '../../api.ts';
import { useCategories, useFeedsRefresh } from '../../composables/useFeeds.ts';
import { subscriptionKey } from '../../lib/streams.ts';
import { useUiStore } from '../../stores/ui.ts';

const ui = useUiStore();
const router = useRouter();
const { t } = useI18n();
const categories = useCategories();
const refreshFeeds = useFeedsRefresh();

const url = ref('');
const categoryId = ref<number | null>(null);
const candidates = ref<FeedCandidate[]>([]);
const chosen = ref<string | null>(null);
const busy = ref(false);
const error = ref<string | null>(null);

watch(
  () => ui.subscribeOpen,
  (open) => {
    if (!open) return;
    url.value = '';
    candidates.value = [];
    chosen.value = null;
    error.value = null;
  },
);

async function submit() {
  const target = candidates.value.length > 0 ? chosen.value : url.value.trim();
  if (!target) return;
  busy.value = true;
  error.value = null;
  try {
    const result = await api.subscriptions.subscribe({ url: target, categoryId: categoryId.value });
    if (result.status === 'choose') {
      candidates.value = result.candidates;
      chosen.value = result.candidates[0]?.url ?? null;
      return;
    }
    await refreshFeeds();
    ui.subscribeOpen = false;
    ui.notify(t('subscribe.done', { feed: result.subscription.title }));
    await router.push(`/${subscriptionKey(result.subscription.id)}`);
  } catch (err) {
    error.value = err instanceof ApiError ? err.message : t('errors.generic');
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <v-dialog v-model="ui.subscribeOpen" max-width="520">
    <v-card :title="t('subscribe.title')">
      <v-form @submit.prevent="submit">
        <v-card-text>
          <v-text-field
            v-model="url"
            :label="t('subscribe.url')"
            :hint="t('subscribe.urlHint')"
            persistent-hint
            autofocus
            type="url"
            inputmode="url"
            :disabled="candidates.length > 0"
          />
          <v-select
            v-model="categoryId"
            class="mt-4"
            :label="t('feeds.category')"
            :items="[
              { title: t('tree.uncategorised'), value: null },
              ...(categories.data.value ?? []).map((c) => ({ title: c.title, value: c.id })),
            ]"
          />
          <template v-if="candidates.length > 0">
            <p class="text-body-medium mb-2">{{ t('subscribe.choose') }}</p>
            <v-radio-group v-model="chosen" hide-details>
              <v-radio
                v-for="candidate in candidates"
                :key="candidate.url"
                :value="candidate.url"
                :label="candidate.title ? `${candidate.title} — ${candidate.url}` : candidate.url"
              />
            </v-radio-group>
          </template>
          <v-alert v-if="error" type="error" variant="tonal" density="compact" class="mt-4">
            {{ error }}
          </v-alert>
        </v-card-text>
        <v-card-actions>
          <v-spacer />
          <v-btn @click="ui.subscribeOpen = false">{{ t('common.cancel') }}</v-btn>
          <v-btn type="submit" color="primary" variant="flat" :loading="busy">
            {{ t('feeds.subscribe') }}
          </v-btn>
        </v-card-actions>
      </v-form>
    </v-card>
  </v-dialog>
</template>
