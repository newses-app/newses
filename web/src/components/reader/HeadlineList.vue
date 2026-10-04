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
const emit = defineEmits<{ loadMore: []; toggleStar: [entry: Entry] }>();
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
      <template v-for="entry in entries" :key="entry.id">
        <v-list-item
          :to="link(entry)"
          :active="entry.id === selectedId"
          :data-entry="entry.id"
          :class="{ unread: entry.unread }"
          class="headline"
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
            <span>{{ entry.feedTitle }}</span> ·
            <time :datetime="entry.sortAt">{{ formatRelative(entry.sortAt, locale) }}</time>
            <template v-if="showPreview && entry.excerpt"> — {{ entry.excerpt }}</template>
          </v-list-item-subtitle>
          <template #append>
            <v-btn
              :icon="entry.starred ? mdiStar : mdiStarOutline"
              :color="entry.starred ? 'amber-darken-2' : undefined"
              size="small"
              density="comfortable"
              :aria-label="entry.starred ? t('entries.unstar') : t('entries.star')"
              :aria-pressed="entry.starred"
              @click.prevent.stop="emit('toggleStar', entry)"
            />
          </template>
        </v-list-item>
        <v-divider />
      </template>
    </v-list>
    <p v-else-if="!loading" class="pa-6 text-medium-emphasis">{{ t('entries.empty') }}</p>
    <div ref="sentinel" class="pa-2 d-flex justify-center">
      <v-progress-circular v-if="loading" indeterminate size="24" />
    </div>
  </div>
</template>

<style scoped>
.headline:not(.unread) .headline-title {
  font-weight: 400;
  opacity: 0.75;
}
.headline.unread .headline-title {
  font-weight: 700;
}
</style>
