<script setup lang="ts">
import { mdiAlertCircleOutline, mdiCancel, mdiRss } from '@mdi/js';
import { inject, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import type { FeedNode } from '../../lib/tree.ts';
import { TREE_CONTEXT } from './tree-context.ts';
import UnreadCount from './UnreadCount.vue';

const props = defineProps<{ node: FeedNode; depth: number }>();
const { t } = useI18n();
const context = inject(TREE_CONTEXT);
if (!context) throw new Error('FeedTreeFeed must be inside FeedTree');
const { dragged, editing, current } = context;
const over = ref(false);
const iconFailed = ref(false);

function onDragStart(event: DragEvent) {
  dragged.value = { kind: 'feed', id: props.node.subscription.id };
  event.dataTransfer?.setData('text/plain', props.node.subscription.title);
}

function onDragOver(event: DragEvent) {
  if (dragged.value?.kind !== 'feed' || dragged.value.id === props.node.subscription.id) return;
  event.preventDefault();
  over.value = true;
}

function onDrop() {
  over.value = false;
  const item = dragged.value;
  dragged.value = null;
  if (item?.kind !== 'feed') return;
  const { id, categoryId } = props.node.subscription;
  void editing.moveFeed(item.id, categoryId, id);
}
</script>

<template>
  <div role="listitem">
    <v-list-item
      :to="`/${node.key}`"
      :active="current === node.key"
      draggable="true"
      :class="{ 'drop-before': over, 'text-medium-emphasis': node.subscription.disabled }"
      :style="{ paddingInlineStart: `${12 + depth * 16}px` }"
      @dragstart="onDragStart"
      @dragend="dragged = null"
      @dragover="onDragOver"
      @dragleave="over = false"
      @drop.prevent="onDrop"
    >
      <template #prepend>
        <img
          v-if="node.subscription.iconUrl && !iconFailed"
          :src="node.subscription.iconUrl"
          alt=""
          width="16"
          height="16"
          class="me-3"
          loading="lazy"
          @error="iconFailed = true"
        />
        <v-icon v-else :icon="mdiRss" size="16" class="me-3" />
      </template>
      <v-list-item-title :class="{ 'font-weight-bold': node.unread > 0 }">
        {{ node.subscription.title }}
      </v-list-item-title>
      <template #append>
        <template v-if="node.subscription.disabled">
          <v-icon
            :icon="mdiCancel"
            size="small"
            color="error"
            :title="t('feeds.disabled', { error: node.subscription.lastError ?? '' })"
            class="ms-1"
          />
          <span class="d-sr-only">{{ t('settings.disabledStatus') }}</span>
        </template>
        <template v-else-if="node.subscription.errorCount > 0">
          <v-icon
            :icon="mdiAlertCircleOutline"
            size="small"
            color="warning"
            :title="node.subscription.lastError ?? ''"
            class="ms-1"
          />
          <span class="d-sr-only">{{
            t('settings.failing', { n: node.subscription.errorCount }, node.subscription.errorCount)
          }}</span>
        </template>
        <UnreadCount v-if="node.unread > 0" :n="node.unread" class="ms-1" />
      </template>
    </v-list-item>
  </div>
</template>

<style scoped>
.drop-before {
  box-shadow: inset 0 2px 0 rgb(var(--v-theme-primary));
}
</style>
