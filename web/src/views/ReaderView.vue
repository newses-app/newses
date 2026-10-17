<script setup lang="ts">
import type { Entry, EntryState } from '@newses/shared';
import {
  mdiArchiveOutline,
  mdiArchiveSearchOutline,
  mdiArrowLeft,
  mdiCheckAll,
  mdiDotsVertical,
  mdiEye,
  mdiMagnify,
  mdiPencil,
  mdiRefresh,
  mdiSort,
  mdiViewAgendaOutline,
  mdiViewSplitVertical,
} from '@mdi/js';
import { useQueryClient } from '@tanstack/vue-query';
import { computed, nextTick, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { useRoute, useRouter } from 'vue-router';
import { useDisplay } from 'vuetify';
import { api, ApiError } from '../api.ts';
import ArticlePane from '../components/reader/ArticlePane.vue';
import CombinedList from '../components/reader/CombinedList.vue';
import HeadlineList from '../components/reader/HeadlineList.vue';
import { useCounters } from '../composables/useCounters.ts';
import { useDocumentTitle } from '../composables/useDocumentTitle.ts';
import { useIconSrc } from '../composables/useIconSrc.ts';
import { useOnlineOnly } from '../composables/useOnlineOnly.ts';
import { ENTRIES_KEY, useEntry, useEntryActions, useEntryList } from '../composables/useEntries.ts';
import { useCategories, useSubscriptions } from '../composables/useFeeds.ts';
import { useLabels } from '../composables/useLabels.ts';
import { usePrefs } from '../composables/usePrefs.ts';
import { useShortcutHandler } from '../composables/useShortcuts.ts';
import { useTreeEditing } from '../composables/useTreeEditing.ts';
import type { ShortcutAction } from '../lib/shortcuts.ts';
import { safeUrl } from '../lib/format.ts';
import {
  labelKey,
  parseStream,
  SPECIAL_FEEDS,
  type StreamKey,
  subscriptionKey,
} from '../lib/streams.ts';
import { buildTree, flattenTree } from '../lib/tree.ts';
import { connectivity } from '../offline/connectivity.ts';
import { currentStore } from '../offline/store.ts';
import { bridge } from '../platform/index.ts';
import { useUiStore } from '../stores/ui.ts';

const { t } = useI18n();
const route = useRoute();
const router = useRouter();
const display = useDisplay();
const ui = useUiStore();
const queryClient = useQueryClient();
const { prefs, update } = usePrefs();
const subscriptions = useSubscriptions();
const categories = useCategories();
const labels = useLabels();
const counters = useCounters();
const actions = useEntryActions();
const editing = useTreeEditing();

const streamKey = computed<StreamKey>(() => String(route.params.stream));
const stream = computed(() => parseStream(streamKey.value));
const entryId = computed(() => (route.params.entry ? Number(route.params.entry) : null));
const q = computed(() =>
  typeof route.query.q === 'string' && route.query.q ? route.query.q : null,
);
const combined = computed(() => prefs.value.layout === 'combined');
/** Phone width: secondary toolbar actions move into a menu. */
const compact = computed(() => display.width.value < 700);
const searchOpen = ref(false);
const VIEW_MODES = ['adaptive', 'all', 'unread'] as const;
const ORDERS = ['newest', 'oldest', 'title'] as const;
const layoutLabel = computed(() => (combined.value ? t('layout.threePane') : t('layout.combined')));
/** Below tablet width one pane shows at a time: the list, or the open article. */
const singlePane = computed(() => display.width.value < 900);

const list = useEntryList(() => ({
  stream: streamKey.value,
  view: prefs.value.viewMode,
  order: prefs.value.sortOrder,
  q: q.value,
  content: combined.value,
}));
const entries = list.entries;
const loading = computed(() => list.isPending.value || list.isFetchingNextPage.value);
const fromList = computed(() => entries.value.find((e) => e.id === entryId.value));
const opened = useEntry(() => (fromList.value ? null : entryId.value));
const current = computed<Entry | undefined>(() => fromList.value ?? opened.data.value);

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

const subscription = computed(() =>
  stream.value.subscriptionId === undefined
    ? undefined
    : subscriptions.data.value?.find((s) => s.id === stream.value.subscriptionId),
);
const title = computed(() => {
  const { special, categoryId, labelId, tag } = stream.value;
  if (special) return t(`special.${streamKey.value}`);
  if (tag !== undefined) return t('tags.stream', { tag });
  if (labelId !== undefined) return labels.data.value?.find((l) => l.id === labelId)?.caption ?? '';
  if (subscription.value) return subscription.value.title;
  if (categoryId === 0) return t('tree.uncategorised');
  return categories.data.value?.find((c) => c.id === categoryId)?.title ?? '';
});
/** The archive this stream browses: the subscription's, or every feed's from All articles. */
const archiveStream = computed(() =>
  subscription.value
    ? subscriptionKey(subscription.value.id)
    : streamKey.value === 'all'
      ? 'all'
      : null,
);
function browseArchive(withSearch = false) {
  void router.push({
    name: 'archive',
    params: { stream: archiveStream.value ?? 'all' },
    query: withSearch && q.value ? { q: q.value } : {},
  });
}

const unread = computed(() => {
  const data = counters.data.value;
  const { special, subscriptionId, categoryId, labelId } = stream.value;
  if (!data) return 0;
  if (labelId !== undefined) return data.labels.find((l) => l.id === labelId)?.unread ?? 0;
  if (special && special !== 'recentlyRead') return data.special[special];
  if (subscriptionId !== undefined)
    return data.subscriptions.find((s) => s.id === subscriptionId)?.unread ?? 0;
  if (categoryId !== undefined)
    return data.categories.find((c) => c.id === categoryId)?.unread ?? 0;
  return 0;
});

useDocumentTitle(() =>
  entryId.value !== null && current.value?.title
    ? `${current.value.title} – ${title.value}`
    : title.value,
);

function notifyError(error: unknown) {
  if (error instanceof ApiError) ui.notify(error.message, true);
  else ui.notify(t(connectivity.value === 'online' ? 'errors.generic' : 'offline.notSaved'), true);
}

function change(entries: Entry[], state: EntryState) {
  actions.setState(entries, state).catch(notifyError);
}

/**
 * Reading marks entries read; without a connection only when offline reading keeps the change, as
 * it could not be saved otherwise.
 */
function readAutomatically(entries: Entry[]) {
  if (connectivity.value === 'online' || currentStore()) change(entries, { unread: false });
}

// Opening an entry marks it read once; toggling it unread again leaves it unread.
let autoRead: number | null = null;
watch(
  [entryId, () => current.value?.id],
  () => {
    const entry = current.value;
    if (!entry || entry.id !== entryId.value || autoRead === entry.id) return;
    autoRead = entry.id;
    if (entry.unread) readAutomatically([entry]);
  },
  { immediate: true },
);

function open(entry: Entry | undefined, replace = false) {
  if (!entry) return;
  const to = {
    name: 'reader',
    params: { stream: streamKey.value, entry: String(entry.id) },
    query: route.query,
  };
  void (replace ? router.replace(to) : router.push(to));
}

// Opening an article from the list moves focus to its heading, so keyboard and screen-reader users
// land on it; shortcuts leave focus where it is.
let focusOnOpen: number | null = null;
function focusHeading() {
  void nextTick(() =>
    document
      .querySelector<HTMLElement>('.article-pane .entry-heading')
      ?.focus({ preventScroll: true }),
  );
}
function openedFromList(entry: Entry) {
  if (entry.id === entryId.value) focusHeading();
  else focusOnOpen = entry.id;
}
watch(
  () => current.value?.id,
  (id) => {
    if (id === undefined || id !== focusOnOpen) return;
    focusOnOpen = null;
    focusHeading();
  },
);

async function closeArticle() {
  const id = entryId.value;
  await router.push({ name: 'reader', params: { stream: streamKey.value }, query: route.query });
  // On phones the list comes back: focus returns to the article's headline.
  if (singlePane.value && id !== null) {
    await nextTick();
    document.querySelector<HTMLElement>(`[data-entry="${String(id)}"] a`)?.focus();
  }
}

async function step(delta: 1 | -1) {
  // A key pressed while the first page loads acts once it arrives.
  if (list.isPending.value)
    await new Promise<void>((resolve) => {
      const stop = watch(list.isPending, (pending) => {
        if (pending) return;
        stop();
        resolve();
      });
    });
  const index = entries.value.findIndex((e) => e.id === entryId.value);
  const target = index === -1 ? (delta === 1 ? 0 : -1) : index + delta;
  if (target >= entries.value.length && list.hasNextPage.value) await list.fetchNextPage();
  open(entries.value[target], entryId.value !== null);
}

function stepFeed(delta: 1 | -1) {
  const tree = buildTree(
    categories.data.value ?? [],
    subscriptions.data.value ?? [],
    counters.data.value,
    {
      hideRead: prefs.value.hideReadFeeds,
      keep: streamKey.value,
    },
  );
  const keys = flattenTree(tree, [
    ...SPECIAL_FEEDS.map((s) => s.key),
    ...(labels.data.value ?? []).map((l) => labelKey(l.id)),
  ]);
  const next = keys[keys.indexOf(streamKey.value) + delta];
  if (next) void router.push(`/${next}`);
}

function scrollArticle(direction: 1 | -1) {
  const scroller = document.querySelector<HTMLElement>('.article-scroll');
  scroller?.scrollBy({ top: direction * scroller.clientHeight * 0.9, behavior: 'smooth' });
}

const searchText = ref(q.value ?? '');
watch(q, (value) => (searchText.value = value ?? ''));
const searchField = ref<{ focus: () => void } | null>(null);
async function openSearch() {
  searchOpen.value = true;
  await nextTick();
  searchField.value?.focus();
}
const { online, whenOnline } = useOnlineOnly();
/** The archive is on the server only. */
const browseArchiveOnline = whenOnline((search?: boolean) => browseArchive(search));

/** Searching needs the server until articles on the device can be searched. */
function search() {
  const text = searchText.value.trim();
  if (text && !online.value) {
    ui.notify(t('offline.needsConnection'));
    return;
  }
  void router.push({
    name: 'reader',
    params: { stream: streamKey.value },
    query: text ? { q: text } : {},
  });
}

async function catchUp(olderThanDays?: number) {
  const target = q.value ? t('catchUp.thisStream') : title.value;
  if (
    prefs.value.confirmCatchUp &&
    !(await ui.confirm(
      t('catchUp.title'),
      t('catchUp.confirm', { feed: target }),
      t('catchUp.action'),
    ))
  )
    return;
  try {
    const updated = await actions.markRead({
      ...stream.value,
      ...(olderThanDays !== undefined && { olderThanDays }),
    });
    ui.notify(t('catchUp.done', { n: updated }, updated));
  } catch (error) {
    notifyError(error);
  }
}

/** Reloads the list; online, the server also fetches the feed. */
async function refresh() {
  if (subscription.value && online.value) {
    try {
      await api.subscriptions.refresh(subscription.value.id);
      ui.notify(t('feeds.refreshRequested'));
      // Give the worker a moment, then show what arrived.
      setTimeout(() => void queryClient.invalidateQueries({ queryKey: [ENTRIES_KEY] }), 5000);
    } catch (error) {
      notifyError(error);
    }
  }
  await queryClient.invalidateQueries({ queryKey: [ENTRIES_KEY] });
}

function toggleCategory() {
  const categoryId = stream.value.categoryId ?? subscription.value?.categoryId;
  const category = categories.data.value?.find((c) => c.id === categoryId);
  if (category) void editing.setCollapsed(category.id, !category.collapsed);
}

useShortcutHandler((action: ShortcutAction) => {
  const entry = current.value;
  switch (action) {
    case 'nextArticle':
      void step(1);
      return true;
    case 'prevArticle':
      void step(-1);
      return true;
    case 'nextFeed':
      stepFeed(1);
      return true;
    case 'prevFeed':
      stepFeed(-1);
      return true;
    case 'pageDown':
      scrollArticle(1);
      return true;
    case 'pageUp':
      scrollArticle(-1);
      return true;
    case 'toggleStar':
      if (entry) change([entry], { starred: !entry.starred });
      return true;
    case 'togglePublished':
      if (entry) change([entry], { published: !entry.published });
      return true;
    case 'toggleUnread':
      if (entry) change([entry], { unread: !entry.unread });
      return true;
    case 'editNote':
      if (entry) ui.noteEntry = entry;
      return true;
    case 'editLabels':
      if (entry) ui.labelsEntry = entry;
      return true;
    case 'editTags':
      if (entry) ui.tagsEntry = entry;
      return true;
    case 'openOriginal': {
      const link = safeUrl(entry?.link);
      if (link) void bridge.openExternal(link);
      return true;
    }
    case 'closeArticle':
      if (entryId.value !== null) void closeArticle();
      return true;
    case 'search':
      void openSearch();
      return true;
    case 'refreshFeed':
      void refresh();
      return true;
    case 'editFeed':
      if (subscription.value) ui.editSubscriptionId = subscription.value.id;
      return true;
    case 'catchUpFeed':
      void catchUp();
      return true;
    case 'catchUpAll':
      void router.push('/all').then(() => catchUp());
      return true;
    case 'reverseOrder':
      update({ sortOrder: prefs.value.sortOrder === 'oldest' ? 'newest' : 'oldest' });
      return true;
    case 'toggleCombined':
      update({ layout: combined.value ? 'threePane' : 'combined' });
      return true;
    case 'expandAllCategories':
      void editing.setAllCollapsed(false);
      return true;
    case 'collapseAllCategories':
      void editing.setAllCollapsed(true);
      return true;
    case 'toggleCategory':
      toggleCategory();
      return true;
    default:
      return false;
  }
});

const showList = computed(() => !singlePane.value || entryId.value === null || combined.value);
const showArticle = computed(
  () => !combined.value && (!singlePane.value || entryId.value !== null),
);
</script>

<template>
  <v-app-bar density="compact" flat border="b">
    <template #prepend>
      <v-btn
        v-if="singlePane && entryId !== null && !combined"
        :icon="mdiArrowLeft"
        :aria-label="t('nav.back')"
        @click="closeArticle"
      />
      <v-app-bar-nav-icon v-else :aria-label="t('nav.menu')" @click="ui.drawer = !ui.drawer" />
    </template>
    <v-app-bar-title v-if="!compact || !searchOpen" tag="h1">
      {{ title }}
      <span v-if="unread > 0" class="text-body-medium text-medium-emphasis ms-1"
        >({{ unread }})</span
      >
    </v-app-bar-title>
    <v-text-field
      v-if="!compact || searchOpen"
      ref="searchField"
      v-model="searchText"
      :prepend-inner-icon="mdiMagnify"
      :placeholder="t('search.placeholder')"
      :aria-label="t('search.label')"
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
      :aria-label="t('search.label')"
      :title="t('search.label')"
      @click="openSearch"
    />
    <v-btn
      v-if="q !== null"
      :icon="mdiArchiveSearchOutline"
      :aria-label="t('archive.searchFor', { q })"
      :title="t('archive.searchFor', { q })"
      :aria-disabled="!online"
      @click="browseArchiveOnline(true)"
    />
    <template v-if="!compact">
      <v-menu>
        <template #activator="{ props: menu }">
          <v-btn
            v-bind="menu"
            :icon="mdiEye"
            :aria-label="t('view.label')"
            :title="t('view.label')"
          />
        </template>
        <v-list
          density="compact"
          :selected="[prefs.viewMode]"
          @update:selected="([v]) => v && update({ viewMode: v })"
        >
          <v-list-item
            v-for="mode in VIEW_MODES"
            :key="mode"
            :value="mode"
            :title="t(`view.${mode}`)"
          />
        </v-list>
      </v-menu>
      <v-menu>
        <template #activator="{ props: menu }">
          <v-btn
            v-bind="menu"
            :icon="mdiSort"
            :aria-label="t('order.label')"
            :title="t('order.label')"
            :disabled="q !== null"
          />
        </template>
        <v-list
          density="compact"
          :selected="[prefs.sortOrder]"
          @update:selected="([v]) => v && update({ sortOrder: v })"
        >
          <v-list-item
            v-for="order in ORDERS"
            :key="order"
            :value="order"
            :title="t(`order.${order}`)"
          />
        </v-list>
      </v-menu>
      <v-btn
        :icon="combined ? mdiViewSplitVertical : mdiViewAgendaOutline"
        :aria-label="layoutLabel"
        :title="layoutLabel"
        @click="update({ layout: combined ? 'threePane' : 'combined' })"
      />
    </template>
    <v-menu>
      <template #activator="{ props: menu }">
        <v-btn
          v-bind="menu"
          :icon="mdiCheckAll"
          :aria-label="t('catchUp.title')"
          :title="t('catchUp.title')"
        />
      </template>
      <v-list density="compact" role="menu">
        <v-list-item role="menuitem" :title="t('catchUp.all')" @click="catchUp()" />
        <v-list-item
          v-for="days in [1, 7, 14]"
          :key="days"
          role="menuitem"
          :title="t('catchUp.olderThan', { n: days }, days)"
          @click="catchUp(days)"
        />
      </v-list>
    </v-menu>
    <template v-if="!compact">
      <v-btn
        :icon="mdiRefresh"
        :aria-label="t('feeds.refresh')"
        :title="t('feeds.refresh')"
        @click="refresh"
      />
      <v-btn
        v-if="archiveStream"
        :icon="mdiArchiveOutline"
        :aria-label="t('archive.browse')"
        :title="t('archive.browse')"
        :aria-disabled="!online"
        @click="browseArchiveOnline()"
      />
      <v-btn
        v-if="subscription"
        :icon="mdiPencil"
        :aria-label="t('feeds.edit')"
        :title="t('feeds.edit')"
        @click="ui.editSubscriptionId = subscription.id"
      />
    </template>
    <v-menu v-else>
      <template #activator="{ props: menu }">
        <v-btn v-bind="menu" :icon="mdiDotsVertical" :aria-label="t('nav.more')" />
      </template>
      <v-list density="compact" role="menu">
        <div role="group" :aria-label="t('view.label')">
          <v-list-subheader aria-hidden="true">{{ t('view.label') }}</v-list-subheader>
          <v-list-item
            v-for="mode in VIEW_MODES"
            :key="mode"
            role="menuitemradio"
            :aria-checked="prefs.viewMode === mode"
            :title="t(`view.${mode}`)"
            :active="prefs.viewMode === mode"
            @click="update({ viewMode: mode })"
          />
        </div>
        <div v-if="q === null" role="group" :aria-label="t('order.label')">
          <v-list-subheader aria-hidden="true">{{ t('order.label') }}</v-list-subheader>
          <v-list-item
            v-for="order in ORDERS"
            :key="order"
            role="menuitemradio"
            :aria-checked="prefs.sortOrder === order"
            :title="t(`order.${order}`)"
            :active="prefs.sortOrder === order"
            @click="update({ sortOrder: order })"
          />
        </div>
        <v-divider class="my-1" />
        <v-list-item
          role="menuitem"
          :title="layoutLabel"
          @click="update({ layout: combined ? 'threePane' : 'combined' })"
        />
        <v-list-item role="menuitem" :title="t('feeds.refresh')" @click="refresh" />
        <v-list-item
          v-if="archiveStream"
          role="menuitem"
          :title="t('archive.browse')"
          :aria-disabled="!online"
          @click="browseArchiveOnline()"
        />
        <v-list-item
          v-if="subscription"
          role="menuitem"
          :title="t('feeds.edit')"
          @click="ui.editSubscriptionId = subscription.id"
        />
      </v-list>
    </v-menu>
  </v-app-bar>

  <v-main id="main" tabindex="-1" class="reader-main">
    <div class="d-flex fill-height">
      <div
        v-if="showList"
        :class="combined || singlePane ? 'flex-grow-1' : 'headlines-pane'"
        class="fill-height list-pane"
      >
        <CombinedList
          v-if="combined"
          :entries="entries"
          :selected-id="entryId"
          :mark-read-on-scroll="prefs.markReadOnScroll"
          :has-more="list.hasNextPage.value"
          :loading="loading"
          @load-more="list.fetchNextPage()"
          @select="(entry) => open(entry, entryId !== null)"
          @change="(entry, state) => change([entry], state)"
          @scrolled-past="readAutomatically"
        />
        <HeadlineList
          v-else
          :entries="entries"
          :selected-id="entryId"
          :icons="icons"
          :show-preview="prefs.showContentPreview"
          :has-more="list.hasNextPage.value"
          :loading="loading"
          @load-more="list.fetchNextPage()"
          @open="openedFromList"
          @toggle-star="(entry) => change([entry], { starred: !entry.starred })"
        />
      </div>
      <div v-if="showArticle" class="flex-grow-1 fill-height article-pane">
        <ArticlePane
          :entry-id="entryId"
          :from-list="fromList"
          @change="(entry, state) => change([entry], state)"
        />
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
/* Panes shrink to the screen rather than grow to fit wide images or code in articles. */
.list-pane,
.article-pane {
  min-width: 0;
}
.search-field {
  max-width: 18rem;
  min-width: 8rem;
}
</style>
