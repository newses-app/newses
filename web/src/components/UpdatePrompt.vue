<script setup lang="ts">
import { computed, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { updates } from '../platform/index.ts';
import { promptVersion } from '../platform/updates.ts';

const { t } = useI18n();
/** Later hides the prompt for that version until the app restarts. */
const dismissed = ref<string | null>(null);
const version = computed(() => promptVersion(updates.status.value, dismissed.value));
const ready = computed(() => updates.status.value.state === 'ready');
const open = computed({
  get: () => version.value !== null,
  set: (value) => {
    if (!value) dismissed.value = version.value;
  },
});

function install() {
  dismissed.value = version.value;
  void updates.install();
}
</script>

<template>
  <v-dialog v-model="open" max-width="420">
    <v-card
      :title="t('updates.title')"
      :text="t(ready ? 'updates.readyPrompt' : 'updates.availablePrompt', { version })"
    >
      <v-card-actions>
        <v-spacer />
        <v-btn @click="open = false">{{ t('updates.later') }}</v-btn>
        <v-btn color="primary" variant="flat" autofocus @click="install">
          {{ t(ready ? 'updates.restart' : 'updates.download') }}
        </v-btn>
      </v-card-actions>
    </v-card>
  </v-dialog>
</template>
