<script setup lang="ts">
import { MAX_SCORE } from '@rss-reader/shared/client';
import { computed, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { ApiError } from '../../api.ts';
import { useEntryActions } from '../../composables/useEntries.ts';
import { useReturnFocus } from '../../composables/useReturnFocus.ts';
import { parseScore } from '../../lib/score.ts';
import { useUiStore } from '../../stores/ui.ts';

const ui = useUiStore();
const { t, n } = useI18n();
const actions = useEntryActions();

const open = computed({
  get: () => ui.scoreEntry !== null,
  set: (value) => {
    if (!value) ui.scoreEntry = null;
  },
});
const restoreFocus = useReturnFocus(() => open.value);

const text = ref('');
const busy = ref(false);
const invalid = computed(() => t('entries.scoreInvalid', { max: n(MAX_SCORE) }));

watch(
  () => ui.scoreEntry,
  (entry) => {
    if (entry) text.value = String(entry.score);
  },
);

async function save(score: number | null) {
  const entry = ui.scoreEntry;
  if (!entry || score === null) return;
  busy.value = true;
  try {
    await actions.setState([entry], { score });
    open.value = false;
    ui.notify(t('entries.scoreSaved'));
  } catch (error) {
    ui.notify(error instanceof ApiError ? error.message : t('errors.generic'), true);
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <v-dialog v-model="open" max-width="420" @after-leave="restoreFocus">
    <v-card
      v-if="ui.scoreEntry"
      :title="t('entries.setScore')"
      :subtitle="ui.scoreEntry.title ?? t('entries.untitled')"
    >
      <v-form @submit.prevent="save(parseScore(text))">
        <v-card-text>
          <v-text-field
            v-model="text"
            :label="t('entries.score')"
            :hint="t('entries.scoreHint')"
            persistent-hint
            inputmode="numeric"
            :rules="[(v: string) => parseScore(v) !== null || invalid]"
            autofocus
          />
        </v-card-text>
        <v-card-actions class="flex-wrap">
          <v-btn v-if="ui.scoreEntry.score !== 0" :disabled="busy" @click="save(0)">
            {{ t('entries.resetScore') }}
          </v-btn>
          <v-spacer />
          <v-btn @click="open = false">{{ t('common.cancel') }}</v-btn>
          <v-btn
            type="submit"
            color="primary"
            variant="flat"
            :loading="busy"
            :disabled="parseScore(text) === null"
          >
            {{ t('common.save') }}
          </v-btn>
        </v-card-actions>
      </v-form>
    </v-card>
  </v-dialog>
</template>
