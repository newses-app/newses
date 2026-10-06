<script setup lang="ts">
import { mdiChevronDown, mdiChevronRight, mdiFolder, mdiFolderOpen } from '@mdi/js';
import { computed, inject, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import type { CategoryNode } from '../../lib/tree.ts';
import FeedTreeFeed from './FeedTreeFeed.vue';
import { TREE_CONTEXT } from './tree-context.ts';
import UnreadCount from './UnreadCount.vue';

const props = defineProps<{ node: CategoryNode; depth: number }>();
const { t } = useI18n();
const context = inject(TREE_CONTEXT);
if (!context) throw new Error('FeedTreeCategory must be inside FeedTree');
const { dragged, editing, current } = context;

const collapsed = computed(() => props.node.category.collapsed);
const drop = ref<'before' | 'into' | null>(null);

function onDragStart(event: DragEvent) {
  dragged.value = { kind: 'category', id: props.node.category.id };
  event.dataTransfer?.setData('text/plain', props.node.category.title);
}

function onDragOver(event: DragEvent) {
  if (
    !dragged.value ||
    (dragged.value.kind === 'category' && dragged.value.id === props.node.category.id)
  )
    return;
  event.preventDefault();
  const target = event.currentTarget as HTMLElement;
  const upper = event.offsetY < target.offsetHeight * 0.3;
  drop.value = dragged.value.kind === 'category' && upper ? 'before' : 'into';
}

function onDrop() {
  const item = dragged.value;
  const position = drop.value;
  drop.value = null;
  dragged.value = null;
  if (!item || !position) return;
  const { id, parentId } = props.node.category;
  if (item.kind === 'feed') void editing.moveFeed(item.id, id, null);
  else if (position === 'before') void editing.moveCategory(item.id, parentId, id);
  else void editing.moveCategory(item.id, id, null);
}
</script>

<template>
  <!-- The collapse button sits beside the link, not inside it. -->
  <div role="listitem" class="category-row">
    <v-list-item
      :to="`/${node.key}`"
      :active="current === node.key"
      draggable="true"
      :class="{ 'drop-before': drop === 'before', 'drop-into': drop === 'into' }"
      :style="{ paddingInlineStart: `${4 + depth * 16}px` }"
      @dragstart="onDragStart"
      @dragend="dragged = null"
      @dragover="onDragOver"
      @dragleave="drop = null"
      @drop.prevent="onDrop"
    >
      <template #prepend>
        <span class="toggle-space" />
        <v-icon :icon="collapsed ? mdiFolder : mdiFolderOpen" size="small" class="me-2" />
      </template>
      <v-list-item-title>{{ node.category.title }}</v-list-item-title>
      <template v-if="node.unread > 0" #append>
        <UnreadCount :n="node.unread" />
      </template>
    </v-list-item>
    <v-btn
      :icon="collapsed ? mdiChevronRight : mdiChevronDown"
      size="x-small"
      density="comfortable"
      class="toggle"
      :style="{ insetInlineStart: `${4 + depth * 16}px` }"
      :aria-label="
        t(collapsed ? 'tree.expandNamed' : 'tree.collapseNamed', { category: node.category.title })
      "
      :aria-expanded="!collapsed"
      @click="editing.setCollapsed(node.category.id, !collapsed)"
    />
  </div>
  <template v-if="!collapsed">
    <FeedTreeCategory
      v-for="child in node.children"
      :key="child.key"
      :node="child"
      :depth="depth + 1"
    />
    <FeedTreeFeed v-for="feed in node.feeds" :key="feed.key" :node="feed" :depth="depth + 1" />
  </template>
</template>

<style scoped>
.category-row {
  position: relative;
}
.toggle {
  position: absolute;
  top: 50%;
  transform: translateY(-50%);
}
.toggle-space {
  display: inline-block;
  width: 32px;
}
.drop-before {
  box-shadow: inset 0 2px 0 rgb(var(--v-theme-primary));
}
.drop-into {
  background: rgba(var(--v-theme-primary), 0.12);
}
</style>
