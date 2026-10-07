<script setup lang="ts">
import type { Entry, EntryState } from '@rss-reader/shared';
import { nextTick, onBeforeUnmount, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { usePrefs } from '../../composables/usePrefs.ts';
import { useSentinel } from '../../composables/useSentinel.ts';
import { isHighScore } from '../../lib/score.ts';
import EntryArticle from './EntryArticle.vue';

const props = defineProps<{
  entries: Entry[];
  selectedId: number | null;
  markReadOnScroll: boolean;
  hasMore: boolean;
  loading: boolean;
}>();
const emit = defineEmits<{
  loadMore: [];
  select: [entry: Entry];
  change: [entry: Entry, state: EntryState];
  scrolledPast: [entries: Entry[]];
}>();
const { t } = useI18n();
const { prefs } = usePrefs();

const scroller = ref<HTMLElement | null>(null);
const sentinel = ref<HTMLElement | null>(null);
useSentinel(sentinel, () => {
  if (props.hasMore && !props.loading) emit('loadMore');
});

// Entries scrolled entirely above the top are marked read in batches, one request per second.
const pending = new Set<number>();
let flush: ReturnType<typeof setTimeout> | undefined;
const observer = new IntersectionObserver((records) => {
  for (const record of records) {
    const above =
      !record.isIntersecting && record.boundingClientRect.bottom <= (record.rootBounds?.top ?? 0);
    const id = Number((record.target as HTMLElement).dataset.entry);
    if (above && props.markReadOnScroll) pending.add(id);
  }
  if (pending.size > 0 && flush === undefined)
    flush = setTimeout(() => {
      flush = undefined;
      const read = props.entries.filter((e) => pending.has(e.id) && e.unread);
      pending.clear();
      if (read.length > 0) emit('scrolledPast', read);
    }, 1000);
});

watch(
  () => props.entries.map((e) => e.id).join(),
  async () => {
    await nextTick();
    observer.disconnect();
    for (const card of scroller.value?.querySelectorAll('[data-entry]') ?? [])
      observer.observe(card);
  },
  { immediate: true },
);

watch(
  () => props.selectedId,
  async (id) => {
    await nextTick();
    const card = scroller.value?.querySelector(`[data-entry="${String(id)}"]`);
    const view = scroller.value?.getBoundingClientRect();
    if (!card || !view) return;
    // Keyboard moves bring the card's top into view; a click on a visible card does not scroll.
    const top = card.getBoundingClientRect().top;
    if (top < view.top || top > view.bottom - 48) card.scrollIntoView({ block: 'start' });
  },
);

onBeforeUnmount(() => {
  observer.disconnect();
  clearTimeout(flush);
});
</script>

<template>
  <div ref="scroller" class="article-scroll fill-height overflow-y-auto pa-2 pa-md-4">
    <v-card
      v-for="entry in entries"
      :key="entry.id"
      :data-entry="entry.id"
      :variant="entry.id === selectedId ? 'outlined' : 'flat'"
      :class="{
        read: !entry.unread && entry.id !== selectedId,
        'high-score': isHighScore(entry.score, prefs.scoreHighlightAbove),
      }"
      class="combined-card mb-4 pa-4 mx-auto"
      @click="emit('select', entry)"
    >
      <EntryArticle :entry="entry" @change="(state) => emit('change', entry, state)" />
    </v-card>
    <p v-if="entries.length === 0 && !loading" class="pa-6 text-medium-emphasis">
      {{ t('entries.empty') }}
    </p>
    <div ref="sentinel" class="pa-2 d-flex justify-center">
      <v-progress-circular
        v-if="loading"
        indeterminate
        size="24"
        :aria-label="t('common.loading')"
      />
    </div>
  </div>
</template>

<style scoped>
.combined-card {
  max-width: var(--article-width, 50rem);
}
.combined-card.high-score {
  box-shadow: inset 3px 0 rgb(var(--v-theme-primary));
}
/* Read entries dim their heading only, which keeps every text above AA contrast. */
.combined-card.read :deep(.entry-heading) {
  opacity: 0.75;
}
</style>
