<script setup lang="ts">
import { MAX_PAGE_TEXT_LENGTH, MAX_PAGE_TITLE_LENGTH } from '@newses/shared/client';
import { useQueryClient } from '@tanstack/vue-query';
import { ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { api, ApiError } from '../../api.ts';
import { COUNTERS_KEY } from '../../composables/useCounters.ts';
import { ENTRIES_KEY } from '../../composables/useEntries.ts';
import { useOnlineOnly } from '../../composables/useOnlineOnly.ts';
import { useReturnFocus } from '../../composables/useReturnFocus.ts';
import { useUiStore } from '../../stores/ui.ts';

const ui = useUiStore();
const { t } = useI18n();
const queryClient = useQueryClient();
const { online, whenOnline } = useOnlineOnly();

const url = ref('');
const title = ref('');
const text = ref('');
const busy = ref(false);
const error = ref<string | null>(null);
const restoreFocus = useReturnFocus(() => ui.publishOpen);

// Opening starts afresh, or with a page shared to the app, also while open.
watch(
  () => [ui.publishOpen, ui.publishDraft] as const,
  ([open, draft], previous) => {
    if (!open || (previous?.[0] && !draft)) return;
    url.value = draft?.url ?? '';
    title.value = draft?.title ?? '';
    text.value = draft?.text ?? '';
    ui.publishDraft = null;
    error.value = null;
  },
  { immediate: true },
);

async function publish() {
  if (!url.value.trim()) return;
  busy.value = true;
  error.value = null;
  try {
    const entry = await api.publishedFeed.publish({
      url: url.value.trim(),
      title: title.value.trim() || null,
      text: text.value.trim() || null,
    });
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: [ENTRIES_KEY] }),
      queryClient.invalidateQueries({ queryKey: COUNTERS_KEY }),
    ]);
    ui.publishOpen = false;
    ui.notify(t('publish.done', { title: entry.title ?? entry.link ?? '' }));
  } catch (err) {
    error.value = err instanceof ApiError ? err.message : t('errors.generic');
  } finally {
    busy.value = false;
  }
}

const submit = whenOnline(publish);
</script>

<template>
  <v-dialog v-model="ui.publishOpen" max-width="560" @after-leave="restoreFocus">
    <v-card :title="t('publish.title')">
      <v-form @submit.prevent="submit">
        <v-card-text>
          <v-text-field
            v-model="url"
            :label="t('publish.url')"
            autofocus
            type="url"
            inputmode="url"
          />
          <v-text-field
            v-model="title"
            class="mt-2"
            :label="t('publish.pageTitle')"
            :hint="t('publish.pageTitleHint')"
            persistent-hint
            :maxlength="MAX_PAGE_TITLE_LENGTH"
          />
          <v-textarea
            v-model="text"
            class="mt-4"
            :label="t('publish.text')"
            :hint="t('publish.textHint')"
            persistent-hint
            auto-grow
            rows="3"
            :maxlength="MAX_PAGE_TEXT_LENGTH"
          />
          <v-alert v-if="error" type="error" variant="tonal" density="compact" class="mt-4">
            {{ error }}
          </v-alert>
        </v-card-text>
        <v-card-actions>
          <v-spacer />
          <v-btn @click="ui.publishOpen = false">{{ t('common.cancel') }}</v-btn>
          <v-btn
            type="submit"
            color="primary"
            variant="flat"
            :loading="busy"
            :disabled="!url.trim()"
            :aria-disabled="!online"
          >
            {{ t('publish.submit') }}
          </v-btn>
        </v-card-actions>
      </v-form>
    </v-card>
  </v-dialog>
</template>
