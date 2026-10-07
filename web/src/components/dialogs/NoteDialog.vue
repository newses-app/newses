<script setup lang="ts">
import { MAX_NOTE_LENGTH } from '@rss-reader/shared/client';
import { computed, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { ApiError } from '../../api.ts';
import { useEntryActions } from '../../composables/useEntries.ts';
import { useReturnFocus } from '../../composables/useReturnFocus.ts';
import { useUiStore } from '../../stores/ui.ts';

const ui = useUiStore();
const { t } = useI18n();
const actions = useEntryActions();

const open = computed({
  get: () => ui.noteEntry !== null,
  set: (value) => {
    if (!value) ui.noteEntry = null;
  },
});
const restoreFocus = useReturnFocus(() => open.value);

const text = ref('');
const busy = ref(false);

watch(
  () => ui.noteEntry,
  (entry) => {
    if (entry) text.value = entry.note ?? '';
  },
);

async function save(note: string | null) {
  const entry = ui.noteEntry;
  if (!entry) return;
  busy.value = true;
  try {
    await actions.setNote(entry, note);
    open.value = false;
    ui.notify(note?.trim() ? t('entries.noteSaved') : t('entries.noteCleared'));
  } catch (error) {
    ui.notify(error instanceof ApiError ? error.message : t('errors.generic'), true);
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <v-dialog v-model="open" max-width="560" @after-leave="restoreFocus">
    <v-card
      v-if="ui.noteEntry"
      :title="ui.noteEntry.note ? t('entries.editNote') : t('entries.addNote')"
      :subtitle="ui.noteEntry.title ?? t('entries.untitled')"
    >
      <v-form @submit.prevent="save(text)">
        <v-card-text>
          <v-textarea
            v-model="text"
            :label="t('entries.note')"
            :maxlength="MAX_NOTE_LENGTH"
            auto-grow
            rows="4"
            autofocus
          />
        </v-card-text>
        <v-card-actions class="flex-wrap">
          <v-btn v-if="ui.noteEntry.note" color="error" :disabled="busy" @click="save(null)">
            {{ t('entries.clearNote') }}
          </v-btn>
          <v-spacer />
          <v-btn @click="open = false">{{ t('common.cancel') }}</v-btn>
          <v-btn type="submit" color="primary" variant="flat" :loading="busy">
            {{ t('common.save') }}
          </v-btn>
        </v-card-actions>
      </v-form>
    </v-card>
  </v-dialog>
</template>
