<script setup lang="ts">
import type { Entry, EntryState } from '@rss-reader/shared';
import {
  mdiEmailMarkAsUnread,
  mdiEmailOpenOutline,
  mdiOpenInNew,
  mdiPaperclip,
  mdiShareVariant,
  mdiShareVariantOutline,
  mdiStar,
  mdiStarOutline,
} from '@mdi/js';
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { formatDateTime } from '../../lib/format.ts';

const props = defineProps<{ entry: Entry; heading?: 'h1' | 'h2' }>();
const emit = defineEmits<{ change: [state: EntryState]; select: [] }>();
const { t, locale } = useI18n();

const date = computed(() =>
  formatDateTime(props.entry.publishedAt ?? props.entry.sortAt, locale.value),
);
const title = computed(() => props.entry.title ?? t('entries.untitled'));
</script>

<template>
  <article class="entry-article">
    <header class="mb-4">
      <component :is="heading ?? 'h1'" class="text-headline-small mb-1">
        <a
          v-if="entry.link"
          :href="entry.link"
          target="_blank"
          rel="noopener noreferrer"
          class="entry-title"
          @click="emit('select')"
          >{{ title }}</a
        >
        <span v-else>{{ title }}</span>
      </component>
      <div class="text-body-medium text-medium-emphasis">
        <span v-if="entry.feedTitle">{{ entry.feedTitle }}</span>
        <span v-if="entry.author"> · {{ entry.author }}</span>
        <span>
          · <time :datetime="entry.publishedAt ?? entry.sortAt">{{ date }}</time></span
        >
      </div>
      <div class="mt-2 d-flex flex-wrap ga-1">
        <v-btn
          size="small"
          :prepend-icon="entry.starred ? mdiStar : mdiStarOutline"
          :color="entry.starred ? 'amber-darken-2' : undefined"
          :aria-pressed="entry.starred"
          @click="emit('change', { starred: !entry.starred })"
        >
          {{ entry.starred ? t('entries.unstar') : t('entries.star') }}
        </v-btn>
        <v-btn
          size="small"
          :prepend-icon="entry.published ? mdiShareVariant : mdiShareVariantOutline"
          :aria-pressed="entry.published"
          @click="emit('change', { published: !entry.published })"
        >
          {{ entry.published ? t('entries.unpublish') : t('entries.publish') }}
        </v-btn>
        <v-btn
          size="small"
          :prepend-icon="entry.unread ? mdiEmailOpenOutline : mdiEmailMarkAsUnread"
          @click="emit('change', { unread: !entry.unread })"
        >
          {{ entry.unread ? t('entries.markRead') : t('entries.markUnread') }}
        </v-btn>
        <v-btn
          v-if="entry.link"
          size="small"
          :prepend-icon="mdiOpenInNew"
          :href="entry.link"
          target="_blank"
          rel="noopener noreferrer"
        >
          {{ t('entries.openOriginal') }}
        </v-btn>
      </div>
    </header>
    <v-skeleton-loader v-if="entry.content === undefined" type="paragraph@3" />
    <!-- Content is sanitised by the server against an allow-list before storage. -->
    <!-- eslint-disable-next-line vue/no-v-html -->
    <div v-else-if="entry.content" class="article-content" v-html="entry.content" />
    <p v-else class="text-medium-emphasis">{{ entry.excerpt ?? t('entries.noContent') }}</p>
    <v-list v-if="entry.enclosures?.length" density="compact" class="mt-4">
      <v-list-subheader>{{ t('entries.attachments') }}</v-list-subheader>
      <v-list-item
        v-for="enclosure in entry.enclosures"
        :key="enclosure.url"
        :href="enclosure.url"
        target="_blank"
        rel="noopener noreferrer"
        :prepend-icon="mdiPaperclip"
        :title="enclosure.url.split('/').pop() || enclosure.url"
        :subtitle="enclosure.mimeType ?? ''"
      />
    </v-list>
  </article>
</template>

<style scoped>
.entry-title {
  color: inherit;
  text-decoration: none;
}
.entry-title:hover {
  text-decoration: underline;
}
</style>
