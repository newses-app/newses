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
  mdiWhiteBalanceSunny,
} from '@mdi/js';
import { computed, provide, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { useRoute } from 'vue-router';
import { useCounters } from '../../composables/useCounters.ts';
import { useCategories, useSubscriptions } from '../../composables/useFeeds.ts';
import { usePrefs } from '../../composables/usePrefs.ts';
import { useSession } from '../../composables/useSession.ts';
import { type Dragged, useTreeEditing } from '../../composables/useTreeEditing.ts';
import { buildTree } from '../../lib/tree.ts';
import { useUiStore } from '../../stores/ui.ts';
import FeedTreeCategory from './FeedTreeCategory.vue';
import FeedTreeFeed from './FeedTreeFeed.vue';
import { TREE_CONTEXT } from './tree-context.ts';

const { t } = useI18n();
const route = useRoute();
const ui = useUiStore();
const { prefs } = usePrefs();
const { logout } = useSession();
const counters = useCounters();
const subscriptions = useSubscriptions();
const categories = useCategories();
const editing = useTreeEditing();

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
      <v-list-item
        v-for="item in special"
        :key="item.key"
        :to="`/${item.key}`"
        :active="current === item.key"
        :prepend-icon="item.icon"
        :title="t(`special.${item.key}`)"
      >
        <template v-if="item.unread > 0" #append>
          <span class="text-label-medium" :aria-label="t('tree.unread', { n: item.unread })">
            {{ item.unread }}
          </span>
        </template>
      </v-list-item>
      <v-divider class="my-2" />
      <FeedTreeCategory v-for="node in tree.categories" :key="node.key" :node="node" :depth="0" />
      <FeedTreeFeed v-for="node in tree.feeds" :key="node.key" :node="node" :depth="0" />
      <div
        v-if="dragged"
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
        class="text-body-small pa-4 text-medium-emphasis"
      >
        {{ t('tree.empty') }}
      </p>
    </v-list>
    <v-divider />
    <v-list density="compact" nav>
      <v-list-item :to="{ name: 'settings' }" :prepend-icon="mdiCog" :title="t('nav.settings')" />
      <v-list-item :prepend-icon="mdiLogout" :title="t('nav.logout')" @click="logout" />
    </v-list>
  </div>
</template>

<style scoped>
.tree {
  --v-list-prepend-gap: 12px;
}
.drop-root {
  border: 1px dashed rgba(var(--v-theme-on-surface), 0.4);
  border-radius: 4px;
}
.drop-root.over {
  background: rgba(var(--v-theme-primary), 0.12);
}
</style>
