<script setup lang="ts">
import type { Entry } from '@rss-reader/shared';
import { mdiRss, mdiStar, mdiStarOutline } from '@mdi/js';
import { nextTick, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { useRoute } from 'vue-router';
import { useSentinel } from '../../composables/useSentinel.ts';
import { formatRelative } from '../../lib/format.ts';

const props = defineProps<{
  entries: Entry[];
  selectedId: number | null;
  icons: Map<number, string>;
  showPreview: boolean;
  hasMore: boolean;
  loading: boolean;
}>();
const emit = defineEmits<{ loadMore: []; open: [entry: Entry]; toggleStar: [entry: Entry] }>();
const { t, locale } = useI18n();
const route = useRoute();

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
      <!-- Each row is a listitem holding the link and, beside it, the star button. -->
      <div
        v-for="entry in entries"
        :key="entry.id"
        role="listitem"
        :data-entry="entry.id"
        class="headline-row"
      >
        <v-list-item
          :to="link(entry)"
          :active="entry.id === selectedId"
          :class="{ unread: entry.unread }"
          class="headline"
          @click="emit('open', entry)"
        >
          <template #prepend>
            <img
              v-if="entry.subscriptionId && icons.get(entry.subscriptionId)"
              :src="icons.get(entry.subscriptionId)"
              alt=""
              width="16"
              height="16"
              class="me-3 align-self-start mt-1"
              loading="lazy"
            />
            <v-icon v-else :icon="mdiRss" size="16" class="me-3 align-self-start mt-1" />
          </template>
          <v-list-item-title class="headline-title">
            {{ entry.title ?? t('entries.untitled') }}
          </v-list-item-title>
          <v-list-item-subtitle>
            <span v-if="entry.unread" class="d-sr-only">{{ t('entries.unreadLabel') }} · </span>
            <span>{{ entry.feedTitle }}</span> ·
            <time :datetime="entry.sortAt">{{ formatRelative(entry.sortAt, locale) }}</time>
            <template v-if="showPreview && entry.excerpt"> — {{ entry.excerpt }}</template>
          </v-list-item-subtitle>
        </v-list-item>
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
  padding-inline-end: 48px;
}
.star {
  position: absolute;
  top: 8px;
  inset-inline-end: 8px;
}
.headline:not(.unread) .headline-title {
  font-weight: 400;
  opacity: 0.75;
}
.headline.unread .headline-title {
  font-weight: 700;
}
</style>
