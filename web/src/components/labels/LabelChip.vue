<script setup lang="ts">
import type { Label } from '@rss-reader/shared';

defineProps<{ label: Label; to?: string | undefined }>();
</script>

<template>
  <router-link
    v-if="to"
    :to="to"
    class="label-chip"
    :style="{ color: label.fgColor, backgroundColor: label.bgColor }"
    >{{ label.caption }}</router-link
  >
  <span v-else class="label-chip" :style="{ color: label.fgColor, backgroundColor: label.bgColor }">
    {{ label.caption }}
  </span>
</template>

<style scoped>
.label-chip {
  display: inline-block;
  max-width: 12rem;
  padding: 0 0.5em;
  border-radius: 0.75em;
  font-size: 0.75rem;
  line-height: 1.5;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  vertical-align: middle;
  text-decoration: none;
}
a.label-chip:hover,
a.label-chip:focus-visible {
  text-decoration: underline;
}
</style>
