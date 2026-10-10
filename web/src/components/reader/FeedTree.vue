<script setup lang="ts">
import {
  mdiCog,
  mdiFolderOutline,
  mdiHistory,
  mdiLogout,
  mdiNewspaperVariantMultipleOutline,
  mdiPlus,
  mdiShareVariantOutline,
  mdiStarOutline,
  mdiTagMultipleOutline,
  mdiUnfoldLessHorizontal,
  mdiUnfoldMoreHorizontal,
  mdiWhiteBalanceSunny,
} from '@mdi/js';
import { computed, provide, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { useRoute } from 'vue-router';
import { useCounters } from '../../composables/useCounters.ts';
import { useCategories, useSubscriptions } from '../../composables/useFeeds.ts';
import { useLabels } from '../../composables/useLabels.ts';
import { usePrefs } from '../../composables/usePrefs.ts';
import { useSession } from '../../composables/useSession.ts';
import { type Dragged, useTreeEditing } from '../../composables/useTreeEditing.ts';
import { labelKey, parseStream } from '../../lib/streams.ts';
import { buildTree } from '../../lib/tree.ts';
import { useUiStore } from '../../stores/ui.ts';
import FeedTreeCategory from './FeedTreeCategory.vue';
import FeedTreeFeed from './FeedTreeFeed.vue';
import { TREE_CONTEXT } from './tree-context.ts';
import UnreadCount from './UnreadCount.vue';

const { t } = useI18n();
const route = useRoute();
const ui = useUiStore();
const { prefs } = usePrefs();
const { logout } = useSession();
const counters = useCounters();
const subscriptions = useSubscriptions();
const categories = useCategories();
const editing = useTreeEditing();
const labels = useLabels();

const current = computed(() =>
  typeof route.params.stream === 'string' ? route.params.stream : undefined,
);
const tree = computed(() =>
  buildTree(categories.data.value ?? [], subscriptions.data.value ?? [], counters.data.value, {
    hideRead: prefs.value.hideReadFeeds,
    keep: current.value,
  }),
);

const special = computed(() => {
  const counts = counters.data.value?.special;
  return [
    { key: 'all', icon: mdiNewspaperVariantMultipleOutline, unread: counts?.all ?? 0 },
    { key: 'fresh', icon: mdiWhiteBalanceSunny, unread: counts?.fresh ?? 0 },
    { key: 'starred', icon: mdiStarOutline, unread: counts?.starred ?? 0 },
    { key: 'published', icon: mdiShareVariantOutline, unread: counts?.published ?? 0 },
    { key: 'read', icon: mdiHistory, unread: 0 },
  ];
});

const anyExpanded = computed(() => categories.data.value?.some((c) => !c.collapsed) ?? false);
const anyCollapsed = computed(() => categories.data.value?.some((c) => c.collapsed) ?? false);

const labelItems = computed(() =>
  (labels.data.value ?? []).map((label) => ({
    label,
    key: labelKey(label.id),
    unread: counters.data.value?.labels.find((c) => c.id === label.id)?.unread ?? 0,
  })),
);

const dragged = ref<Dragged | null>(null);
const rootOver = ref(false);
provide(TREE_CONTEXT, { dragged, editing, current });

function dropOnRoot() {
  rootOver.value = false;
  const item = dragged.value;
  dragged.value = null;
  if (item?.kind === 'feed') void editing.moveFeed(item.id, null, null);
  if (item?.kind === 'category') void editing.moveCategory(item.id, null, null);
}
</script>

<template>
  <div class="d-flex flex-column fill-height">
    <div class="pa-2">
      <v-btn
        block
        variant="tonal"
        color="primary"
        :prepend-icon="mdiPlus"
        @click="ui.subscribeOpen = true"
      >
        {{ t('feeds.subscribe') }}
      </v-btn>
    </div>
    <v-list
      density="compact"
      nav
      class="tree flex-grow-1 overflow-y-auto"
      :aria-label="t('tree.label')"
    >
      <!-- Vuetify gives link items role=link, so each sits in its own listitem. -->
      <div v-for="item in special" :key="item.key" role="listitem">
        <v-list-item
          :to="`/${item.key}`"
          :active="current === item.key"
          :prepend-icon="item.icon"
          :title="t(`special.${item.key}`)"
        >
          <template v-if="item.unread > 0" #append>
            <UnreadCount :n="item.unread" />
          </template>
        </v-list-item>
      </div>
      <template v-if="labelItems.length">
        <v-divider class="my-2" role="presentation" />
        <div v-for="item in labelItems" :key="item.key" role="listitem">
          <v-list-item
            :to="`/${item.key}`"
            :active="current === item.key"
            :title="item.label.caption"
          >
            <template #prepend>
              <span
                class="label-swatch"
                :style="{ backgroundColor: item.label.bgColor, borderColor: item.label.fgColor }"
                aria-hidden="true"
              />
            </template>
            <template v-if="item.unread > 0" #append>
              <UnreadCount :n="item.unread" />
            </template>
          </v-list-item>
        </div>
      </template>
      <div role="listitem">
        <v-list-item
          role="button"
          :prepend-icon="mdiTagMultipleOutline"
          :title="t('tags.browse')"
          :active="current !== undefined && parseStream(current).tag !== undefined"
          @click="ui.tagPickerOpen = true"
        />
      </div>
      <v-divider class="my-2" role="presentation" />
      <div v-if="categories.data.value?.length" role="listitem" class="d-flex align-center ps-4">
        <span class="text-label-medium text-medium-emphasis flex-grow-1">{{
          t('tree.feeds')
        }}</span>
        <v-btn
          :icon="mdiUnfoldMoreHorizontal"
          size="x-small"
          variant="text"
          :disabled="!anyCollapsed"
          :aria-label="t('tree.expandAll')"
          :title="t('tree.expandAll')"
          @click="editing.setAllCollapsed(false)"
        />
        <v-btn
          :icon="mdiUnfoldLessHorizontal"
          size="x-small"
          variant="text"
          :disabled="!anyExpanded"
          :aria-label="t('tree.collapseAll')"
          :title="t('tree.collapseAll')"
          @click="editing.setAllCollapsed(true)"
        />
      </div>
      <FeedTreeCategory v-for="node in tree.categories" :key="node.key" :node="node" :depth="0" />
      <FeedTreeFeed v-for="node in tree.feeds" :key="node.key" :node="node" :depth="0" />
      <div
        v-if="dragged"
        role="listitem"
        class="drop-root text-body-small pa-2 ma-1"
        :class="{ over: rootOver }"
        @dragover.prevent="rootOver = true"
        @dragleave="rootOver = false"
        @drop.prevent="dropOnRoot"
      >
        <v-icon :icon="mdiFolderOutline" size="small" class="me-1" />{{ t('tree.dropTopLevel') }}
      </div>
      <p
        v-if="subscriptions.isSuccess.value && subscriptions.data.value?.length === 0"
        role="listitem"
        class="text-body-small pa-4 text-medium-emphasis"
      >
        {{ t('tree.empty') }}
      </p>
    </v-list>
    <v-divider />
    <v-list density="compact" nav class="flex-shrink-0">
      <div role="listitem">
        <v-list-item :to="{ name: 'settings' }" :prepend-icon="mdiCog" :title="t('nav.settings')" />
      </div>
      <div role="listitem">
        <v-list-item
          role="button"
          :prepend-icon="mdiLogout"
          :title="t('nav.logout')"
          @click="logout"
        />
      </div>
    </v-list>
  </div>
</template>

<style scoped>
.tree {
  --v-list-prepend-gap: 12px;
  /* Lets the list shrink and scroll so the actions below stay on screen. */
  min-height: 0;
}
.label-swatch {
  width: 14px;
  height: 14px;
  /* Centred in the 24px icon column, then the tree's prepend gap. */
  margin-inline: 5px 17px;
  border: 2px solid;
  border-radius: 4px;
}
.drop-root {
  border: 1px dashed rgba(var(--v-theme-on-surface), 0.4);
  border-radius: 4px;
}
.drop-root.over {
  background: rgba(var(--v-theme-primary), 0.12);
}
</style>
