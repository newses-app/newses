<script setup lang="ts">
import type { AppTheme } from '@rss-reader/shared';
import { computed, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { useRouter } from 'vue-router';
import { useTheme } from 'vuetify';
import { slow } from './lib/slow-requests.ts';
import UpdatePrompt from './components/UpdatePrompt.vue';
import { bridge, NATIVE } from './platform/index.ts';
import { useUiStore } from './stores/ui.ts';

const { t } = useI18n();
const ui = useUiStore();
const router = useRouter();
const theme = useTheme();
// The shells follow the app's theme: the OS's while it is `system`.
watch(
  () => ({
    preference: theme.isSystem.value ? 'system' : theme.current.value.dark ? 'dark' : 'light',
    dark: theme.current.value.dark,
  }),
  (current) => void bridge.setTheme(current as AppTheme),
  { immediate: true },
);
const open = computed({
  get: () => ui.notice !== null,
  set: (value) => {
    if (!value) ui.notice = null;
  },
});

/** The first navigation waits for the session, so for the server to wake up when it is idle. */
const starting = ref(true);
const failed = ref(false);
router.isReady().then(
  () => {
    starting.value = false;
  },
  () => {
    starting.value = false;
    failed.value = true;
  },
);

function reload() {
  window.location.reload();
}

/** The apps may have the wrong server, or one that is gone. */
function changeServer() {
  failed.value = false;
  void router.push({ name: 'connect' });
}
</script>

<template>
  <v-app>
    <v-progress-linear
      v-if="slow"
      indeterminate
      color="primary"
      :aria-label="t('app.waking')"
      :style="{ position: 'fixed', top: 0, zIndex: 3000 }"
    />
    <div
      v-if="starting || failed"
      class="d-flex flex-column flex-grow-1 align-center justify-center ga-4 pa-4 text-center"
    >
      <template v-if="failed">
        <p class="text-body-medium">{{ t('app.unreachable') }}</p>
        <v-btn color="primary" variant="flat" @click="reload">{{ t('app.retry') }}</v-btn>
        <v-btn v-if="NATIVE" variant="text" @click="changeServer">{{ t('connect.change') }}</v-btn>
      </template>
      <template v-else>
        <v-progress-circular indeterminate color="primary" :aria-label="t('common.loading')" />
        <p role="status" class="text-body-medium">{{ slow ? t('app.waking') : '' }}</p>
      </template>
    </div>
    <router-view />
    <UpdatePrompt v-if="NATIVE" />
    <v-snackbar :model-value="slow && !starting" location="top" timeout="-1">
      {{ t('app.waking') }}
    </v-snackbar>
    <v-snackbar v-model="open" :color="ui.notice?.error ? 'error' : undefined" timeout="4000">
      {{ ui.notice?.text }}
    </v-snackbar>
  </v-app>
</template>
