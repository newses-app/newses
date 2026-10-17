<script setup lang="ts">
import type { ArchivedEntry, EntryState } from '@newses/shared';
import { mdiArrowLeft, mdiMagnify, mdiNewspaperVariantOutline } from '@mdi/js';
import { computed, nextTick, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { useRoute, useRouter } from 'vue-router';
import { useDisplay } from 'vuetify';
import { ApiError } from '../api.ts';
import ArchivedArticle from '../components/reader/ArchivedArticle.vue';
import ArchiveList from '../components/reader/ArchiveList.vue';
import { useArchivedEntry, useArchiveList, useRestore } from '../composables/useArchive.ts';
import { useDocumentTitle } from '../composables/useDocumentTitle.ts';
import { useSubscriptions } from '../composables/useFeeds.ts';
import { useIconSrc } from '../composables/useIconSrc.ts';
import { usePrefs } from '../composables/usePrefs.ts';
import type { ListPosition } from '../lib/list-position.ts';
import { parseStream, subscriptionKey } from '../lib/streams.ts';
import { useUiStore } from '../stores/ui.ts';

const { t } = useI18n();
const route = useRoute();
const router = useRouter();
const display = useDisplay();
const ui = useUiStore();
const { prefs } = usePrefs();
const subscriptions = useSubscriptions();
const restoreEntry = useRestore();

/** `all`, or one subscription's key. */
const streamKey = computed(() => String(route.params.stream));
const subscriptionId = computed(() => parseStream(streamKey.value).subscriptionId ?? null);
const key = computed(() => (route.params.key ? String(route.params.key) : null));
const q = computed(() =>
  typeof route.query.q === 'string' && route.query.q ? route.query.q : null,
);
const compact = computed(() => display.width.value < 700);
const singlePane = computed(() => display.width.value < 900);

const list = useArchiveList(() => ({ subscriptionId: subscriptionId.value, q: q.value }));
const entries = list.entries;
const loading = computed(() => list.isPending.value || list.isFetchingNextPage.value);
const fromList = computed(() => entries.value.find((e) => e.key === key.value));
const opened = useArchivedEntry(key);
// The list's copy shows the header at once; the full copy brings content and enclosures.
const current = computed<ArchivedEntry | undefined>(() => {
  const full = opened.data.value;
  if (full && full.key === key.value) return full;
  return fromList.value && { ...fromList.value, content: undefined };
});

const iconSrc = useIconSrc();
const icons = computed(
  () =>
    new Map(
      (subscriptions.data.value ?? []).flatMap((s) => {
        const src = iconSrc(s);
        return src ? [[s.id, src] as const] : [];
      }),
    ),
);
const feedTitle = computed(() =>
  subscriptionId.value === null
    ? t('archive.allFeeds')
    : (subscriptions.data.value?.find((s) => s.id === subscriptionId.value)?.title ?? ''),
);
const title = computed(() => t('archive.title', { feed: feedTitle.value }));
useDocumentTitle(() =>
  current.value?.title ? `${current.value.title} – ${title.value}` : title.value,
);

const searchText = ref(q.value ?? '');
watch(q, (value) => (searchText.value = value ?? ''));
const searchOpen = ref(false);
const searchField = ref<{ focus: () => void } | null>(null);
async function openSearch() {
  searchOpen.value = true;
  await nextTick();
  searchField.value?.focus();
}
function search() {
  const text = searchText.value.trim();
  void router.push({
    name: 'archive',
    params: { stream: streamKey.value },
    query: text ? { q: text } : {},
  });
}

function back() {
  if (singlePane.value && key.value !== null)
    void router.push({ name: 'archive', params: { stream: streamKey.value }, query: route.query });
  else void router.push({ name: 'reader', params: { stream: streamKey.value } });
}

function focusHeading() {
  void nextTick(() =>
    document.querySelector<HTMLElement>('.article-pane .entry-heading')?.focus({
      preventScroll: true,
    }),
  );
}
watch(() => current.value?.key, focusHeading);

const restoring = ref(false);
/** Brings the article back into its feed with `state`, then shows it there. */
async function restore(state: EntryState, then?: 'note' | 'labels') {
  const entry = current.value;
  if (!entry || restoring.value) return;
  restoring.value = true;
  try {
    const restored = await restoreEntry(entry, state);
    ui.notify(t('archive.restored', { feed: entry.feedTitle ?? '' }));
    await router.push({
      name: 'reader',
      params: {
        stream: subscriptionKey(restored.subscriptionId ?? entry.subscriptionId),
        entry: String(restored.id),
      },
    });
    if (then === 'note') ui.noteEntry = restored;
    if (then === 'labels') ui.labelsEntry = restored;
  } catch (error) {
    ui.notify(error instanceof ApiError ? error.message : t('errors.generic'), true);
  } finally {
    restoring.value = false;
  }
}

// On phones the list leaves while an article is open. Back on the same list, it returns to its
// place and to the headline of the article last read, which takes focus.
const listPosition = ref<ListPosition | null>(null);
const returnedFrom = ref<string | null>(null);
const listContext = computed(() => JSON.stringify([streamKey.value, q.value]));
watch([key, listContext], ([current, context], [previous, previousContext]) => {
  if (context !== previousContext) {
    listPosition.value = null;
    returnedFrom.value = null;
  } else returnedFrom.value = current === null && singlePane.value ? previous : null;
});

const showList = computed(() => !singlePane.value || key.value === null);
const showArticle = computed(() => !singlePane.value || key.value !== null);
const scroller = ref<HTMLElement | null>(null);
watch(key, () => scroller.value?.scrollTo({ top: 0 }));
</script>

<template>
  <v-app-bar density="compact" flat border="b">
    <template #prepend>
      <v-btn
        :icon="mdiArrowLeft"
        :aria-label="t('archive.back')"
        :title="t('archive.back')"
        @click="back"
      />
    </template>
    <v-app-bar-title v-if="!compact || !searchOpen" tag="h1">{{ title }}</v-app-bar-title>
    <v-text-field
      v-if="!compact || searchOpen"
      ref="searchField"
      v-model="searchText"
      :prepend-inner-icon="mdiMagnify"
      :placeholder="t('search.placeholder')"
      :aria-label="t('archive.search')"
      density="compact"
      hide-details
      clearable
      single-line
      :class="compact ? 'flex-grow-1 mx-2' : 'search-field me-2'"
      @keydown.enter="search"
      @keydown.escape="searchOpen = false"
      @click:clear="(searchText = '') || search()"
    />
    <v-btn
      v-else
      :icon="mdiMagnify"
      :aria-label="t('archive.search')"
      :title="t('archive.search')"
      @click="openSearch"
    />
  </v-app-bar>

  <v-main id="main" tabindex="-1" class="reader-main">
    <div class="d-flex fill-height">
      <div
        v-if="showList"
        :class="singlePane ? 'flex-grow-1' : 'headlines-pane'"
        class="fill-height list-pane"
      >
        <ArchiveList
          :entries="entries"
          :selected-key="key"
          :icons="icons"
          :show-preview="prefs.showContentPreview"
          :has-more="list.hasNextPage.value"
          :loading="loading"
          :position="listPosition"
          :returned-from="returnedFrom"
          @load-more="list.fetchNextPage()"
          @save-position="(position) => (listPosition = position)"
        />
      </div>
      <div v-if="showArticle" class="flex-grow-1 fill-height article-pane">
        <div ref="scroller" class="article-scroll fill-height overflow-y-auto">
          <div v-if="current" class="pa-4 pa-md-6 article-column">
            <ArchivedArticle :entry="current" :restoring="restoring" @restore="restore" />
          </div>
          <div v-else-if="opened.isError.value" class="pa-6 text-medium-emphasis">
            {{ t('entries.notFound') }}
          </div>
          <div
            v-else-if="key === null"
            class="fill-height d-flex flex-column align-center justify-center text-medium-emphasis"
          >
            <v-icon :icon="mdiNewspaperVariantOutline" size="48" class="mb-2" />
            {{ t('archive.selectPrompt') }}
          </div>
          <v-skeleton-loader v-else type="article" />
        </div>
      </div>
    </div>
  </v-main>
</template>

<style scoped>
.reader-main {
  height: 100dvh;
}
.headlines-pane {
  width: clamp(18rem, 32vw, 28rem);
  flex-shrink: 0;
  border-inline-end: thin solid rgba(var(--v-border-color), var(--v-border-opacity));
}
.list-pane,
.article-pane {
  min-width: 0;
}
.article-column {
  max-width: var(--article-width, 50rem);
}
.search-field {
  max-width: 18rem;
  min-width: 8rem;
}
</style>
