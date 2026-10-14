<script setup lang="ts">
import type { Label } from '@newses/shared';
import { mdiDelete, mdiLabelOutline, mdiPencil, mdiPlus } from '@mdi/js';
import { computed, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { ApiError } from '../../api.ts';
import { useLabelActions, useLabels } from '../../composables/useLabels.ts';
import { useReturnFocus } from '../../composables/useReturnFocus.ts';
import { contrastRatio, MIN_CONTRAST } from '../../lib/appearance.ts';
import { LABEL_COLORS, nextLabelColors } from '../../lib/labels.ts';
import { useUiStore } from '../../stores/ui.ts';
import LabelChip from '../labels/LabelChip.vue';

const { t } = useI18n();
const ui = useUiStore();
const labels = useLabels();
const actions = useLabelActions();

/** The label being created (`label` null) or edited. */
const editing = ref<{
  label: Label | null;
  caption: string;
  fgColor: string;
  bgColor: string;
} | null>(null);
const restoreFocus = useReturnFocus(() => editing.value !== null);
const busy = ref(false);

const contrast = computed(() =>
  editing.value ? contrastRatio(editing.value.fgColor, editing.value.bgColor) : 21,
);
const preview = computed<Label>(() => ({
  id: 0,
  caption: editing.value?.caption.trim() || t('labels.preview'),
  fgColor: editing.value?.fgColor ?? '#000000',
  bgColor: editing.value?.bgColor ?? '#ffffff',
}));

function newLabel() {
  editing.value = {
    label: null,
    caption: '',
    ...nextLabelColors(labels.data.value?.length ?? 0),
  };
}

function editLabel(label: Label) {
  editing.value = { label, caption: label.caption, fgColor: label.fgColor, bgColor: label.bgColor };
}

async function run(work: () => Promise<unknown>) {
  busy.value = true;
  try {
    await work();
    return true;
  } catch (error) {
    ui.notify(error instanceof ApiError ? error.message : t('errors.generic'), true);
    return false;
  } finally {
    busy.value = false;
  }
}

async function save() {
  const value = editing.value;
  if (!value?.caption.trim()) return;
  const { label, caption, fgColor, bgColor } = value;
  const body = { caption: caption.trim(), fgColor, bgColor };
  const saved = await run(() => (label ? actions.update(label.id, body) : actions.create(body)));
  if (saved) editing.value = null;
}

async function deleteLabel(label: Label) {
  const confirmed = await ui.confirm(
    t('labels.delete'),
    t('labels.deleteConfirm', { label: label.caption }),
    t('common.delete'),
  );
  if (confirmed) await run(() => actions.remove(label.id));
}
</script>

<template>
  <section>
    <div class="d-flex flex-wrap ga-2 mb-6">
      <v-btn color="primary" variant="flat" :prepend-icon="mdiPlus" @click="newLabel">
        {{ t('labels.newLabel') }}
      </v-btn>
    </div>
    <h2 class="text-title-large mb-2">{{ t('labels.title') }}</h2>
    <p class="text-body-small text-medium-emphasis mb-4">{{ t('labels.hint') }}</p>
    <p v-if="labels.data.value?.length === 0" class="text-body-medium text-medium-emphasis">
      {{ t('labels.none') }}
    </p>
    <v-list v-else density="compact">
      <v-list-item v-for="label in labels.data.value" :key="label.id">
        <template #prepend>
          <v-icon :icon="mdiLabelOutline" :color="label.bgColor" />
        </template>
        <LabelChip :label="label" />
        <template #append>
          <v-btn
            :icon="mdiPencil"
            size="small"
            :aria-label="t('labels.editNamed', { label: label.caption })"
            @click="editLabel(label)"
          />
          <v-btn
            :icon="mdiDelete"
            size="small"
            :aria-label="t('labels.deleteNamed', { label: label.caption })"
            @click="deleteLabel(label)"
          />
        </template>
      </v-list-item>
    </v-list>

    <v-dialog
      :model-value="editing !== null"
      max-width="440"
      @update:model-value="(v) => !v && (editing = null)"
      @after-leave="restoreFocus"
    >
      <v-card v-if="editing" :title="editing.label ? t('labels.edit') : t('labels.newLabel')">
        <v-form @submit.prevent="save">
          <v-card-text>
            <v-text-field
              v-model="editing.caption"
              :label="t('labels.caption')"
              maxlength="100"
              autofocus
            />
            <p id="label-presets" class="text-body-medium mb-2">{{ t('labels.presets') }}</p>
            <div class="d-flex flex-wrap ga-2 mb-4" role="group" aria-labelledby="label-presets">
              <button
                v-for="(colors, index) in LABEL_COLORS"
                :key="colors.bgColor"
                type="button"
                class="preset"
                :style="{ color: colors.fgColor, backgroundColor: colors.bgColor }"
                :aria-label="t('labels.preset', { n: index + 1 })"
                :aria-pressed="
                  editing.fgColor === colors.fgColor && editing.bgColor === colors.bgColor
                "
                @click="Object.assign(editing, colors)"
              >
                Aa
              </button>
            </div>
            <v-row dense>
              <v-col cols="6">
                <v-text-field v-model="editing.fgColor" type="color" :label="t('labels.fgColor')" />
              </v-col>
              <v-col cols="6">
                <v-text-field v-model="editing.bgColor" type="color" :label="t('labels.bgColor')" />
              </v-col>
            </v-row>
            <div class="d-flex align-center ga-2">
              <span class="text-body-medium">{{ t('labels.preview') }}:</span>
              <LabelChip :label="preview" />
            </div>
            <v-alert
              v-if="contrast < MIN_CONTRAST"
              type="warning"
              variant="tonal"
              density="compact"
              class="mt-4"
            >
              {{ t('labels.lowContrast', { ratio: contrast.toFixed(1) }) }}
            </v-alert>
          </v-card-text>
          <v-card-actions>
            <v-spacer />
            <v-btn @click="editing = null">{{ t('common.cancel') }}</v-btn>
            <v-btn
              type="submit"
              color="primary"
              variant="flat"
              :loading="busy"
              :disabled="!editing.caption.trim()"
            >
              {{ t('common.save') }}
            </v-btn>
          </v-card-actions>
        </v-form>
      </v-card>
    </v-dialog>
  </section>
</template>

<style scoped>
.preset {
  width: 2.5rem;
  height: 2rem;
  border-radius: 4px;
  font-weight: 600;
}
.preset[aria-pressed='true'] {
  outline: 3px solid rgb(var(--v-theme-primary));
  outline-offset: 2px;
}
</style>
