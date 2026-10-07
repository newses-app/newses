<script setup lang="ts">
import type { Entry, EntryState } from '@rss-reader/shared';
import {
  mdiEmailMarkAsUnread,
  mdiEmailOpenOutline,
  mdiLinkVariant,
  mdiLabelOutline,
  mdiNoteEditOutline,
  mdiNotePlusOutline,
  mdiNoteTextOutline,
  mdiOpenInNew,
  mdiPaperclip,
  mdiShareVariant,
  mdiShareVariantOutline,
  mdiStar,
  mdiStarOutline,
  mdiTagOutline,
} from '@mdi/js';
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { useLabels } from '../../composables/useLabels.ts';
import { formatDateTime, safeUrl } from '../../lib/format.ts';
import { labelKey, streamPath, tagKey } from '../../lib/streams.ts';
import { useUiStore } from '../../stores/ui.ts';
import LabelChip from '../labels/LabelChip.vue';

const props = defineProps<{ entry: Entry }>();
const emit = defineEmits<{ change: [state: EntryState]; select: [] }>();
const { t, locale } = useI18n();
const ui = useUiStore();
const allLabels = useLabels();
const labels = computed(() =>
  (allLabels.data.value ?? []).filter((label) => props.entry.labels.includes(label.id)),
);

const date = computed(() =>
  formatDateTime(props.entry.publishedAt ?? props.entry.sortAt, locale.value),
);
const title = computed(() => props.entry.title ?? t('entries.untitled'));
const link = computed(() => safeUrl(props.entry.link));
const enclosures = computed(() =>
  (props.entry.enclosures ?? []).filter((enclosure) => safeUrl(enclosure.url)),
);
</script>

<template>
  <article class="entry-article">
    <header class="mb-4">
      <h2 class="entry-heading text-headline-small mb-1" tabindex="-1">
        <a
          v-if="link"
          :href="link"
          target="_blank"
          rel="noopener noreferrer"
          class="entry-title"
          @click="emit('select')"
          >{{ title }}</a
        >
        <span v-else>{{ title }}</span>
      </h2>
      <div class="text-body-medium text-medium-emphasis">
        <span v-if="entry.feedTitle">{{ entry.feedTitle }}</span>
        <span v-if="entry.author"> · {{ entry.author }}</span>
        <span>
          · <time :datetime="entry.publishedAt ?? entry.sortAt">{{ date }}</time></span
        >
      </div>
      <ul v-if="labels.length" class="entry-chips mt-2" :aria-label="t('labels.title')">
        <li v-for="label in labels" :key="label.id">
          <LabelChip :label="label" :to="`/${labelKey(label.id)}`" />
        </li>
      </ul>
      <ul v-if="entry.tags.length" class="entry-chips mt-2" :aria-label="t('tags.title')">
        <li v-for="tag in entry.tags" :key="tag">
          <v-chip
            :to="streamPath(tagKey(tag))"
            :prepend-icon="mdiTagOutline"
            size="small"
            variant="outlined"
            >{{ tag }}</v-chip
          >
        </li>
      </ul>
      <div class="mt-2 d-flex flex-wrap ga-1">
        <v-btn
          size="small"
          :prepend-icon="entry.starred ? mdiStar : mdiStarOutline"
          :color="entry.starred ? 'star' : undefined"
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
        <v-btn size="small" :prepend-icon="mdiLabelOutline" @click="ui.labelsEntry = entry">
          {{ t('labels.title') }}
        </v-btn>
        <v-btn size="small" :prepend-icon="mdiTagOutline" @click="ui.tagsEntry = entry">
          {{ t('tags.title') }}
        </v-btn>
        <v-btn
          size="small"
          :prepend-icon="mdiLinkVariant"
          :color="entry.shareId ? 'primary' : undefined"
          @click="ui.shareEntry = entry"
        >
          {{ entry.shareId ? t('sharing.shared') : t('sharing.share') }}
        </v-btn>
        <v-btn
          size="small"
          :prepend-icon="entry.note ? mdiNoteEditOutline : mdiNotePlusOutline"
          @click="ui.noteEntry = entry"
        >
          {{ entry.note ? t('entries.editNote') : t('entries.addNote') }}
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
    <v-alert
      v-if="entry.note"
      :icon="mdiNoteTextOutline"
      :title="t('entries.note')"
      variant="tonal"
      density="compact"
      class="entry-note mb-4"
    >
      {{ entry.note }}
    </v-alert>
    <v-skeleton-loader v-if="entry.content === undefined" type="paragraph@3" />
    <!-- Content is sanitised by the server against an allow-list before storage. -->
    <!-- eslint-disable-next-line vue/no-v-html -->
    <div v-else-if="entry.content" class="article-content" v-html="entry.content" />
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
.entry-heading:focus {
  outline: none;
}
.entry-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  padding: 0;
  list-style: none;
}
.entry-heading {
  font-family: var(--article-font, inherit);
}
.entry-note {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
</style>
