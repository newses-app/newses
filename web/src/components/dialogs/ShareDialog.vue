<script setup lang="ts">
import { mdiOpenInNew } from '@mdi/js';
import { computed, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { ApiError } from '../../api.ts';
import { useEntryActions } from '../../composables/useEntries.ts';
import { useReturnFocus } from '../../composables/useReturnFocus.ts';
import { shareUrl } from '../../lib/sharing.ts';
import { useUiStore } from '../../stores/ui.ts';
import CopyField from '../sharing/CopyField.vue';

const ui = useUiStore();
const { t } = useI18n();
const actions = useEntryActions();

const open = computed({
  get: () => ui.shareEntry !== null,
  set: (value) => {
    if (!value) ui.shareEntry = null;
  },
});
const restoreFocus = useReturnFocus(() => open.value);
const busy = ref(false);
const url = computed(() => (ui.shareEntry?.shareId ? shareUrl(ui.shareEntry.shareId) : null));

async function run(work: () => Promise<void>) {
  busy.value = true;
  try {
    await work();
  } catch (error) {
    ui.notify(error instanceof ApiError ? error.message : t('errors.generic'), true);
  } finally {
    busy.value = false;
  }
}

/** Keeps the dialog's copy of the entry in step with the caches. */
const create = () =>
  run(async () => {
    const entry = ui.shareEntry;
    if (entry) ui.shareEntry = { ...entry, shareId: await actions.share(entry) };
  });

const revoke = () =>
  run(async () => {
    const entry = ui.shareEntry;
    if (!entry) return;
    await actions.unshare(entry);
    ui.shareEntry = { ...entry, shareId: null };
    ui.notify(t('sharing.revoked'));
  });
</script>

<template>
  <v-dialog v-model="open" max-width="560" @after-leave="restoreFocus">
    <v-card
      v-if="ui.shareEntry"
      :title="t('sharing.shareTitle')"
      :subtitle="ui.shareEntry.title ?? t('entries.untitled')"
    >
      <v-card-text>
        <template v-if="url">
          <CopyField :value="url" :label="t('sharing.link')" />
          <p class="text-body-small text-medium-emphasis mt-2">{{ t('sharing.linkHint') }}</p>
        </template>
        <p v-else class="text-body-medium">{{ t('sharing.notShared') }}</p>
      </v-card-text>
      <v-card-actions class="flex-wrap">
        <template v-if="url">
          <v-btn color="error" :disabled="busy" @click="revoke">{{ t('sharing.revoke') }}</v-btn>
          <v-btn
            :href="url"
            target="_blank"
            rel="noopener noreferrer"
            :append-icon="mdiOpenInNew"
            >{{ t('sharing.open') }}</v-btn
          >
        </template>
        <v-spacer />
        <v-btn @click="open = false">{{ t('common.close') }}</v-btn>
        <v-btn v-if="!url" color="primary" variant="flat" :loading="busy" @click="create">
          {{ t('sharing.create') }}
        </v-btn>
      </v-card-actions>
    </v-card>
  </v-dialog>
</template>
