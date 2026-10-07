<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { ApiError } from '../../api.ts';
import { useEntryActions } from '../../composables/useEntries.ts';
import { useLabelActions, useLabels } from '../../composables/useLabels.ts';
import { useReturnFocus } from '../../composables/useReturnFocus.ts';
import { nextLabelColors } from '../../lib/labels.ts';
import { useUiStore } from '../../stores/ui.ts';
import LabelChip from '../labels/LabelChip.vue';

const ui = useUiStore();
const { t } = useI18n();
const labels = useLabels();
const labelActions = useLabelActions();
const entryActions = useEntryActions();

const open = computed({
  get: () => ui.labelsEntry !== null,
  set: (value) => {
    if (!value) ui.labelsEntry = null;
  },
});
const restoreFocus = useReturnFocus(() => open.value);

const selected = ref<number[]>([]);
const caption = ref('');
const busy = ref(false);

watch(
  () => ui.labelsEntry,
  (entry) => {
    if (!entry) return;
    selected.value = [...entry.labels];
    caption.value = '';
  },
);

function notifyError(error: unknown) {
  ui.notify(error instanceof ApiError ? error.message : t('errors.generic'), true);
}

/** Creates a label and selects it; it is saved with the others. */
async function addLabel() {
  const text = caption.value.trim();
  if (!text) return;
  busy.value = true;
  try {
    const label = await labelActions.create({
      caption: text,
      ...nextLabelColors(labels.data.value?.length ?? 0),
    });
    selected.value = [...selected.value, label.id];
    caption.value = '';
  } catch (error) {
    notifyError(error);
  } finally {
    busy.value = false;
  }
}

async function save() {
  const entry = ui.labelsEntry;
  if (!entry) return;
  busy.value = true;
  try {
    await entryActions.setLabels(entry, selected.value);
    open.value = false;
  } catch (error) {
    notifyError(error);
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <v-dialog v-model="open" max-width="440" scrollable @after-leave="restoreFocus">
    <v-card
      v-if="ui.labelsEntry"
      :title="t('labels.forEntry')"
      :subtitle="ui.labelsEntry.title ?? t('entries.untitled')"
    >
      <v-card-text>
        <p v-if="labels.data.value?.length === 0" class="text-body-medium text-medium-emphasis">
          {{ t('labels.none') }}
        </p>
        <fieldset v-else class="label-options">
          <legend class="d-sr-only">{{ t('labels.title') }}</legend>
          <v-checkbox
            v-for="label in labels.data.value"
            :key="label.id"
            v-model="selected"
            :value="label.id"
            density="compact"
            hide-details
          >
            <template #label><LabelChip :label="label" /></template>
          </v-checkbox>
        </fieldset>
        <v-form class="d-flex align-start ga-2 mt-4" @submit.prevent="addLabel">
          <v-text-field
            v-model="caption"
            :label="t('labels.newLabel')"
            maxlength="100"
            density="compact"
          />
          <v-btn type="submit" variant="tonal" :disabled="!caption.trim()" :loading="busy">
            {{ t('labels.add') }}
          </v-btn>
        </v-form>
      </v-card-text>
      <v-card-actions>
        <v-spacer />
        <v-btn @click="open = false">{{ t('common.cancel') }}</v-btn>
        <v-btn color="primary" variant="flat" :loading="busy" @click="save">
          {{ t('common.save') }}
        </v-btn>
      </v-card-actions>
    </v-card>
  </v-dialog>
</template>

<style scoped>
.label-options {
  border: 0;
}
</style>
