<script setup lang="ts">
import { mdiRss } from '@mdi/js';
import { computed, ref, watch } from 'vue';
import { useSubscriptions } from '../../composables/useFeeds.ts';
import { useIconSrc } from '../../composables/useIconSrc.ts';

/** A subscription's icon, or the feed glyph when it has none or it fails to load. */
const props = defineProps<{ subscriptionId: number | null; size?: number }>();
const subscriptions = useSubscriptions();
const iconSrc = useIconSrc();
const failed = ref(false);
const src = computed(() => {
  const subscription = subscriptions.data.value?.find((s) => s.id === props.subscriptionId);
  return subscription ? iconSrc(subscription) : null;
});
watch(src, () => (failed.value = false));
</script>

<template>
  <img
    v-if="src && !failed"
    :src="src"
    alt=""
    :width="size ?? 16"
    :height="size ?? 16"
    class="feed-icon"
    loading="lazy"
    @error="failed = true"
  />
  <v-icon v-else :icon="mdiRss" :size="size ?? 16" class="feed-icon" />
</template>

<style scoped>
.feed-icon {
  vertical-align: text-bottom;
}
</style>
