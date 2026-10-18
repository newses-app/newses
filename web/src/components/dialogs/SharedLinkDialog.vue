<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { useReturnFocus } from '../../composables/useReturnFocus.ts';
import { useUiStore } from '../../stores/ui.ts';

const ui = useUiStore();
const { t } = useI18n();
const open = computed({
  get: () => ui.sharedLink !== null,
  set: (value) => {
    if (!value) ui.sharedLink = null;
  },
});
const restoreFocus = useReturnFocus(() => open.value);

function subscribe() {
  ui.subscribeUrl = ui.sharedLink?.url ?? null;
  ui.sharedLink = null;
  ui.subscribeOpen = true;
}

function publish() {
  const link = ui.sharedLink;
  ui.sharedLink = null;
  if (!link) return;
  ui.publishDraft = { url: link.url, title: link.title };
  ui.publishOpen = true;
}
</script>

<template>
  <v-dialog v-model="open" max-width="520" @after-leave="restoreFocus">
    <v-card :title="t('sharedLink.title')">
      <v-card-text>
        <p v-if="ui.sharedLink?.title" class="text-body-large">{{ ui.sharedLink.title }}</p>
        <p class="text-body-medium text-medium-emphasis text-break">{{ ui.sharedLink?.url }}</p>
      </v-card-text>
      <v-card-actions class="flex-wrap">
        <v-btn @click="open = false">{{ t('common.cancel') }}</v-btn>
        <v-spacer />
        <v-btn variant="tonal" @click="subscribe">{{ t('sharedLink.subscribe') }}</v-btn>
        <v-btn color="primary" variant="flat" @click="publish">
          {{ t('sharedLink.publish') }}
        </v-btn>
      </v-card-actions>
    </v-card>
  </v-dialog>
</template>
