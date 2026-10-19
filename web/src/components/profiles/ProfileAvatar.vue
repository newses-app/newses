<script setup lang="ts">
import type { Profile } from '@newses/shared';
import { profileLabel } from '@newses/shared/client';
import { computed } from 'vue';

const props = defineProps<{ profile: Profile; size?: number }>();

/** Dark enough for white initials at AA contrast in every theme. */
const COLOURS = [
  '#1565c0',
  '#2e7d32',
  '#6a1b9a',
  '#ad1457',
  '#c62828',
  '#00695c',
  '#4e342e',
  '#283593',
  '#bf360c',
];

/** The same colour for a profile on every launch, from its id. */
const colour = computed(() => {
  let hash = 0;
  for (const char of props.profile.id) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return COLOURS[hash % COLOURS.length];
});

const initial = computed(() =>
  (props.profile.label ?? props.profile.login ?? profileLabel(props.profile))
    .charAt(0)
    .toUpperCase(),
);
</script>

<template>
  <v-avatar :size="size ?? 32" :color="colour" class="text-white" aria-hidden="true">
    <span class="text-label-large">{{ initial }}</span>
  </v-avatar>
</template>
