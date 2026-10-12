<script setup lang="ts">
import type { ArchivedEntry } from '@newses/shared';
import { mdiRss } from '@mdi/js';
import { nextTick, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { useRoute } from 'vue-router';
import { useSentinel } from '../../composables/useSentinel.ts';
import { formatRelative } from '../../lib/format.ts';

const props = defineProps<{
  entries: ArchivedEntry[];
  selectedKey: string | null;
  icons: Map<number, string>;
  showPreview: boolean;
  hasMore: boolean;
  loading: boolean;
}>();
const emit = defineEmits<{ loadMore: []; open: [entry: ArchivedEntry] }>();
const { t, locale } = useI18n();
const route = useRoute();

const sentinel = ref<HTMLElement | null>(null);
useSentinel(sentinel, () => {
  if (props.hasMore && !props.loading) emit('loadMore');
});

const list = ref<HTMLElement | null>(null);
watch(
  () => props.selectedKey,
  async (key) => {
    await nextTick();
    if (key)
      list.value
        ?.querySelector(`[data-key="${CSS.escape(key)}"]`)
        ?.scrollIntoView({ block: 'nearest' });
  },
);

const link = (entry: ArchivedEntry) => ({
  name: 'archive',
  params: { stream: route.params.stream, key: entry.key },
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
      :aria-label="t('archive.listLabel')"
    >
      <div
        v-for="entry in entries"
        :key="entry.key"
        role="listitem"
        :data-key="entry.key"
        class="headline-row"
      >
        <v-list-item
          :to="link(entry)"
          :active="entry.key === selectedKey"
          class="headline"
          @click="emit('open', entry)"
        >
          <template #prepend>
            <img
              v-if="icons.get(entry.subscriptionId)"
              :src="icons.get(entry.subscriptionId)"
              alt=""
              width="16"
              height="16"
              class="me-3 align-self-start mt-1"
              loading="lazy"
            />
            <v-icon v-else :icon="mdiRss" size="16" class="me-3 align-self-start mt-1" />
          </template>
          <v-list-item-title>{{ entry.title ?? t('entries.untitled') }}</v-list-item-title>
          <v-list-item-subtitle>
            <span>{{ entry.feedTitle }}</span> ·
            <time :datetime="entry.sortAt">{{ formatRelative(entry.sortAt, locale) }}</time>
            <template v-if="showPreview && entry.excerpt"> — {{ entry.excerpt }}</template>
          </v-list-item-subtitle>
        </v-list-item>
      </div>
    </v-list>
    <p v-else-if="!loading" class="pa-6 text-medium-emphasis">{{ t('archive.empty') }}</p>
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
  border-block-end: thin solid rgba(var(--v-border-color), var(--v-border-opacity));
}
</style>
