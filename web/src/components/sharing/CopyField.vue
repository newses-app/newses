<script setup lang="ts">
import { mdiContentCopy } from '@mdi/js';
import { useI18n } from 'vue-i18n';
import { useUiStore } from '../../stores/ui.ts';

const props = defineProps<{ value: string; label: string }>();
const { t } = useI18n();
const ui = useUiStore();

async function copy() {
  try {
    await navigator.clipboard.writeText(props.value);
    ui.notify(t('sharing.copied'));
  } catch {
    ui.notify(t('sharing.copyFailed'), true);
  }
}
</script>

<template>
  <v-text-field
    :model-value="value"
    :label="label"
    readonly
    hide-details
    @focus="($event.target as HTMLInputElement).select()"
  >
    <template #append-inner>
      <v-btn
        :icon="mdiContentCopy"
        size="small"
        variant="text"
        :aria-label="t('sharing.copyNamed', { name: label })"
        @click="copy"
      />
    </template>
  </v-text-field>
</template>
