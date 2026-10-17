<script setup lang="ts">
import type { Entry } from '@newses/shared';
import { mdiNoteTextOutline, mdiRss, mdiShareVariant, mdiStar, mdiStarOutline } from '@mdi/js';
import { computed, nextTick, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { useRoute } from 'vue-router';
import { useLabels } from '../../composables/useLabels.ts';
import { useListPosition } from '../../composables/useListPosition.ts';
import { usePrefs } from '../../composables/usePrefs.ts';
import { useSentinel } from '../../composables/useSentinel.ts';
import { formatRelative } from '../../lib/format.ts';
import type { ListPosition } from '../../lib/list-position.ts';
import { isHighScore } from '../../lib/score.ts';
import LabelChip from '../labels/LabelChip.vue';
import ScoreBadge from './ScoreBadge.vue';

const props = defineProps<{
  entries: Entry[];
  selectedId: number | null;
  icons: Map<number, string>;
  showPreview: boolean;
  hasMore: boolean;
  loading: boolean;
  /** Where to scroll back to when the list mounts again. */
  position: ListPosition | null;
  /** The entry the reader came back from, shown and focused once the list is back. */
  returnedFrom: number | null;
}>();
const emit = defineEmits<{
  loadMore: [];
  open: [entry: Entry];
  toggleStar: [entry: Entry];
  savePosition: [position: ListPosition];
}>();
const { t, locale } = useI18n();
const route = useRoute();
const labels = useLabels();
const labelsById = computed(() => new Map((labels.data.value ?? []).map((l) => [l.id, l])));
const entryLabels = (entry: Entry) => entry.labels.flatMap((id) => labelsById.value.get(id) ?? []);
const { prefs } = usePrefs();
const high = (entry: Entry) => isHighScore(entry.score, prefs.value.scoreHighlightAbove);

const sentinel = ref<HTMLElement | null>(null);
useSentinel(sentinel, () => {
  if (props.hasMore && !props.loading) emit('loadMore');
});

const list = ref<HTMLElement | null>(null);
watch(
  () => props.selectedId,
  async (id) => {
    await nextTick();
    list.value?.querySelector(`[data-entry="${String(id)}"]`)?.scrollIntoView({ block: 'nearest' });
  },
);
useListPosition(list, {
  attr: 'entry',
  count: () => props.entries.length,
  position: () => props.position,
  returnedFrom: () => (props.returnedFrom === null ? null : String(props.returnedFrom)),
  save: (position) => emit('savePosition', position),
});

const link = (entry: Entry) => ({
  name: 'reader',
  params: { stream: route.params.stream, entry: String(entry.id) },
  query: route.query,
});
</script>

<template>
  <div ref="list" class="fill-height overflow-y-auto">
    <v-list
      v-if="entries.length > 0"
      density="compact"
      lines="three"
      class="py-0"
      :aria-label="t('entries.listLabel')"
    >
      <!-- Each row is a listitem holding the link and, under its feed icon, the star button. -->
      <div
        v-for="entry in entries"
        :key="entry.id"
        role="listitem"
        :data-entry="entry.id"
        class="headline-row"
        :class="{ 'high-score': high(entry) }"
      >
        <v-list-item
          :to="link(entry)"
          :active="entry.id === selectedId"
          :class="{ unread: entry.unread, selected: entry.id === selectedId }"
          class="headline"
          @click="emit('open', entry)"
        >
          <!-- Wrapped, so a feed glyph doesn't get the wider spacer Vuetify gives prepended icons. -->
          <template #prepend>
            <span class="lead-icon d-inline-flex justify-center me-2 align-self-start mt-1">
              <img
                v-if="entry.subscriptionId && icons.get(entry.subscriptionId)"
                :src="icons.get(entry.subscriptionId)"
                alt=""
                width="16"
                height="16"
                loading="lazy"
              />
              <v-icon v-else :icon="mdiRss" size="16" />
            </span>
          </template>
          <v-list-item-title class="headline-title">
            {{ entry.title ?? t('entries.untitled') }}
            <LabelChip v-for="label in entryLabels(entry)" :key="label.id" :label="label" />
          </v-list-item-title>
          <v-list-item-subtitle>
            <span v-if="entry.unread" class="d-sr-only">{{ t('entries.unreadLabel') }} · </span>
            <span v-if="entry.published" class="d-sr-only"
              >{{ t('entries.publishedLabel') }} ·
            </span>
            <template v-if="entry.score !== 0">
              <ScoreBadge :score="entry.score" :high="high(entry)" /> ·
            </template>
            <span>{{ entry.feedTitle }}</span> ·
            <time :datetime="entry.sortAt">{{ formatRelative(entry.sortAt, locale) }}</time>
            <span v-if="entry.note" class="note">
              —
              <v-icon :icon="mdiNoteTextOutline" size="14" aria-hidden="true" />
              <span class="d-sr-only">{{ t('entries.noteLabel') }}</span>
              {{ entry.note }}
            </span>
            <template v-if="showPreview && entry.excerpt"> — {{ entry.excerpt }}</template>
          </v-list-item-subtitle>
        </v-list-item>
        <div class="lead">
          <v-btn
            :icon="entry.starred ? mdiStar : mdiStarOutline"
            :color="entry.starred ? 'star' : undefined"
            size="small"
            density="comfortable"
            class="star"
            :aria-label="entry.starred ? t('entries.unstar') : t('entries.star')"
            :aria-pressed="entry.starred"
            @click="emit('toggleStar', entry)"
          />
          <v-icon
            v-if="entry.published"
            :icon="mdiShareVariant"
            size="16"
            class="text-medium-emphasis"
            aria-hidden="true"
          />
        </div>
      </div>
    </v-list>
    <p v-else-if="!loading" class="pa-6 text-medium-emphasis">{{ t('entries.empty') }}</p>
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
.headline-row {
  position: relative;
  border-block-end: thin solid rgba(var(--v-border-color), var(--v-border-opacity));
}
.headline {
  padding-inline-start: 6px;
}
.high-score {
  box-shadow: inset 3px 0 rgb(var(--v-theme-primary));
}
/* The feed icon, the star, and the published mark share one column, so the headline keeps the
   rest of the row; star and mark fit under the icon within the row's minimum height. */
.lead-icon {
  width: 28px;
}
.lead {
  position: absolute;
  top: 32px;
  inset-inline-start: 6px;
  width: 28px;
  display: flex;
  flex-direction: column;
  align-items: center;
  pointer-events: none;
}
.star {
  pointer-events: auto;
}
/* Long headlines wrap to a second line, and no further. */
.headline-title {
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
  line-clamp: 2;
  white-space: normal;
  overflow-wrap: anywhere;
  hyphens: manual;
}
.headline:not(.unread) .headline-title {
  font-weight: 400;
  opacity: 0.75;
}
.headline.unread .headline-title {
  font-weight: 700;
}
</style>
