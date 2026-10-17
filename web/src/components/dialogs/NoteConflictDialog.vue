<script setup lang="ts">
import type { Entry } from '@newses/shared';
import { useQueryClient } from '@tanstack/vue-query';
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { api, ApiError } from '../../api.ts';
import { useEntryActions } from '../../composables/useEntries.ts';
import { useReturnFocus } from '../../composables/useReturnFocus.ts';
import { noteConflicts } from '../../offline/status.ts';
import { useUiStore } from '../../stores/ui.ts';

const { t } = useI18n();
const ui = useUiStore();
const queryClient = useQueryClient();
const actions = useEntryActions();

/** One note at a time, oldest first. */
const conflict = computed(() => noteConflicts.value[0] ?? null);
const open = computed({
  get: () => conflict.value !== null,
  set: (value) => {
    if (!value) settle();
  },
});
const restoreFocus = useReturnFocus(() => open.value);

function settle() {
  noteConflicts.value = noteConflicts.value.slice(1);
}

/** The newer note from elsewhere is already on the server, and arrives with the next sync. */
function keepTheirs() {
  settle();
}

async function keepMine() {
  const current = conflict.value;
  if (!current) return;
  settle();
  try {
    const entry =
      queryClient.getQueryData<Entry>(['entry', current.id]) ?? (await api.entries.get(current.id));
    await actions.setNote({ ...entry, note: current.theirs }, current.mine);
  } catch (error) {
    ui.notify(error instanceof ApiError ? error.message : t('errors.generic'), true);
  }
}

async function copyMine() {
  const current = conflict.value;
  if (!current) return;
  try {
    await navigator.clipboard.writeText(current.mine ?? '');
    ui.notify(t('offline.noteCopied'));
  } catch {
    ui.notify(t('errors.generic'), true);
    return;
  }
  settle();
}
</script>

<template>
  <v-dialog v-model="open" max-width="560" @after-leave="restoreFocus">
    <v-card v-if="conflict" :title="t('offline.noteConflictTitle')">
      <v-card-text>
        <p class="mb-3">{{ t('offline.noteConflictText') }}</p>
        <h3 class="text-title-small">{{ t('offline.noteTheirs') }}</h3>
        <p class="note-text mb-3">{{ conflict.theirs ?? t('offline.noteNone') }}</p>
        <h3 class="text-title-small">{{ t('offline.noteMine') }}</h3>
        <p class="note-text">{{ conflict.mine ?? t('offline.noteNone') }}</p>
      </v-card-text>
      <v-card-actions class="flex-wrap">
        <v-spacer />
        <v-btn @click="copyMine">{{ t('offline.copyMine') }}</v-btn>
        <v-btn @click="keepTheirs">{{ t('offline.keepTheirs') }}</v-btn>
        <v-btn color="primary" variant="flat" autofocus @click="keepMine">
          {{ t('offline.keepMine') }}
        </v-btn>
      </v-card-actions>
    </v-card>
  </v-dialog>
</template>

<style scoped>
.note-text {
  white-space: pre-wrap;
}
</style>
