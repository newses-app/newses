<script setup lang="ts">
import type { ArchivedEntry, EntryState } from '@newses/shared';
import {
  mdiArchiveOutline,
  mdiLabelOutline,
  mdiNotePlusOutline,
  mdiOpenInNew,
  mdiPaperclip,
  mdiShareVariantOutline,
  mdiStarOutline,
} from '@mdi/js';
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { formatDateTime, safeUrl } from '../../lib/format.ts';
import { resolveContentUrls } from '../../lib/native-urls.ts';
import { appServer } from '../../platform/index.ts';
import FeedIcon from './FeedIcon.vue';

const props = defineProps<{ entry: ArchivedEntry; restoring: boolean }>();
/** `then` names the dialog to open on the restored entry once it is back in the feed. */
const emit = defineEmits<{ restore: [state: EntryState, then?: 'note' | 'labels'] }>();
const { t, locale } = useI18n();

const date = computed(() =>
  formatDateTime(props.entry.publishedAt ?? props.entry.sortAt, locale.value),
);
const title = computed(() => props.entry.title ?? t('entries.untitled'));
const link = computed(() => safeUrl(props.entry.link));
const content = computed(
  () => props.entry.content && resolveContentUrls(props.entry.content, appServer()),
);
const enclosures = computed(() =>
  (props.entry.enclosures ?? []).filter((enclosure) => safeUrl(enclosure.url)),
);
</script>

<template>
  <article class="entry-article">
    <header class="mb-4">
      <h2 class="entry-heading text-headline-small mt-0 mb-1" tabindex="-1">
        <a v-if="link" :href="link" target="_blank" rel="noopener noreferrer" class="entry-title">{{
          title
        }}</a>
        <span v-else>{{ title }}</span>
      </h2>
      <div class="text-body-medium text-medium-emphasis">
        <span v-if="entry.feedTitle">
          <FeedIcon :subscription-id="entry.subscriptionId" class="me-1" />{{ entry.feedTitle }}
        </span>
        <span v-if="entry.author"> · {{ entry.author }}</span>
        <span>
          · <time :datetime="entry.publishedAt ?? entry.sortAt">{{ date }}</time></span
        >
      </div>
      <v-alert
        :icon="mdiArchiveOutline"
        variant="tonal"
        density="compact"
        class="mt-3"
        :text="t('archive.hint')"
      />
      <div class="mt-3 d-flex flex-wrap ga-1">
        <v-btn
          size="small"
          :prepend-icon="mdiStarOutline"
          :disabled="restoring"
          @click="emit('restore', { starred: true })"
        >
          {{ t('entries.star') }}
        </v-btn>
        <v-btn
          size="small"
          :prepend-icon="mdiShareVariantOutline"
          :disabled="restoring"
          @click="emit('restore', { published: true })"
        >
          {{ t('entries.publish') }}
        </v-btn>
        <v-btn
          size="small"
          :prepend-icon="mdiLabelOutline"
          :disabled="restoring"
          @click="emit('restore', { unread: false }, 'labels')"
        >
          {{ t('labels.title') }}
        </v-btn>
        <v-btn
          size="small"
          :prepend-icon="mdiNotePlusOutline"
          :disabled="restoring"
          @click="emit('restore', { unread: false }, 'note')"
        >
          {{ t('entries.addNote') }}
        </v-btn>
        <v-btn
          v-if="link"
          size="small"
          :prepend-icon="mdiOpenInNew"
          :href="link"
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
    <div v-else-if="content" class="article-content" v-html="content" />
    <p v-else class="text-medium-emphasis">{{ entry.excerpt ?? t('entries.noContent') }}</p>
    <v-list v-if="enclosures.length" density="compact" class="mt-4">
      <v-list-subheader>{{ t('entries.attachments') }}</v-list-subheader>
      <v-list-item
        v-for="enclosure in enclosures"
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
.entry-title:hover,
.entry-title:focus-visible {
  text-decoration: underline;
}
.entry-heading {
  font-family: var(--article-font, inherit);
}
.entry-heading:focus {
  outline: none;
}
</style>
