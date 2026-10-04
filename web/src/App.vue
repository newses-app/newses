<script setup lang="ts">
import { computed } from 'vue';
import { useUiStore } from './stores/ui.ts';

const ui = useUiStore();
const open = computed({
  get: () => ui.notice !== null,
  set: (value) => {
    if (!value) ui.notice = null;
  },
});
</script>

<template>
  <v-app>
    <router-view />
    <v-snackbar v-model="open" :color="ui.notice?.error ? 'error' : undefined" timeout="4000">
      {{ ui.notice?.text }}
    </v-snackbar>
  </v-app>
</template>
