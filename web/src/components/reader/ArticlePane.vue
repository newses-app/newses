<script setup lang="ts">
import type { Entry, EntryState } from '@rss-reader/shared';
import { mdiNewspaperVariantOutline } from '@mdi/js';
import { computed, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { useEntry } from '../../composables/useEntries.ts';
import EntryArticle from './EntryArticle.vue';

const props = defineProps<{ entryId: number | null; fromList: Entry | undefined }>();
const emit = defineEmits<{ change: [entry: Entry, state: EntryState] }>();
const { t } = useI18n();

const query = useEntry(() => props.entryId);
// The list's copy shows the header at once and carries state changes made since loading.
const entry = computed<Entry | undefined>(() => {
  const full = query.data.value;
  if (full && full.id === props.entryId)
    return props.fromList
      ? { ...full, ...props.fromList, content: full.content, enclosures: full.enclosures }
      : full;
  return props.fromList ? { ...props.fromList, content: undefined } : undefined;
});

function onChange(state: EntryState) {
  if (entry.value) emit('change', entry.value, state);
}

const scroller = ref<HTMLElement | null>(null);
watch(
  () => props.entryId,
  () => scroller.value?.scrollTo({ top: 0 }),
);
</script>

<template>
  <div ref="scroller" class="article-scroll fill-height overflow-y-auto">
    <div v-if="entry" class="pa-4 pa-md-6 article-column">
      <EntryArticle :entry="entry" @change="onChange" />
    </div>
    <div v-else-if="query.isError.value" class="pa-6 text-medium-emphasis">
      {{ t('entries.notFound') }}
    </div>
    <div
      v-else-if="entryId === null"
      class="empty fill-height d-flex flex-column align-center justify-center text-medium-emphasis"
    >
      <v-icon :icon="mdiNewspaperVariantOutline" size="48" class="mb-2" />
      {{ t('entries.selectPrompt') }}
    </div>
    <v-skeleton-loader v-else type="article" />
  </div>
</template>

<style scoped>
.article-column {
  max-width: 50rem;
}
</style>
