<script setup lang="ts">
import type { FeedCandidate } from '@newses/shared';
import { ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { useRouter } from 'vue-router';
import { api, ApiError } from '../../api.ts';
import { useResourceEdits } from '../../composables/useResourceEdits.ts';
import { temporaryId } from '../../lib/offline-resources.ts';
import { useCategories, useFeedsRefresh } from '../../composables/useFeeds.ts';
import { useReturnFocus } from '../../composables/useReturnFocus.ts';
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
const restoreFocus = useReturnFocus(() => ui.subscribeOpen);

// Opening starts afresh; a URL shared to the app fills in the address, also while open.
watch(
  () => [ui.subscribeOpen, ui.subscribeUrl] as const,
  ([open, shared], previous) => {
    if (!open || (previous?.[0] && !shared)) return;
    url.value = shared ?? '';
    ui.subscribeUrl = null;
    candidates.value = [];
    chosen.value = null;
    error.value = null;
  },
  { immediate: true },
);

const { edit } = useResourceEdits();

async function submit() {
  const target = candidates.value.length > 0 ? chosen.value : url.value.trim();
  if (!target) return;
  busy.value = true;
  error.value = null;
  try {
    const body = { url: target, categoryId: categoryId.value };
    const saved = await edit({ kind: 'subscription.create', id: temporaryId(), body }, () =>
      api.subscriptions.subscribe(body),
    );
    // Without a connection the feed shows as waiting, and is subscribed once the server answers.
    if (!saved.sent) {
      ui.subscribeOpen = false;
      ui.notify(t('offline.subscribeKept', { url: target }));
      return;
    }
    const result = saved.value;
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
  <v-dialog v-model="ui.subscribeOpen" max-width="520" @after-leave="restoreFocus">
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
            <v-radio-group v-model="chosen" :label="t('subscribe.choose')" hide-details>
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
