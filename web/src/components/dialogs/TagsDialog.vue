<script setup lang="ts">
import { MAX_TAGS_PER_ENTRY, normaliseTags } from '@newses/shared/client';
import { computed, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { ApiError } from '../../api.ts';
import { useEntryActions } from '../../composables/useEntries.ts';
import { useReturnFocus } from '../../composables/useReturnFocus.ts';
import { useTags } from '../../composables/useTags.ts';
import { suggestTags } from '../../lib/tag-suggestions.ts';
import { useUiStore } from '../../stores/ui.ts';

const ui = useUiStore();
const { t } = useI18n();
const actions = useEntryActions();

const open = computed({
  get: () => ui.tagsEntry !== null,
  set: (value) => {
    if (!value) ui.tagsEntry = null;
  },
});
const restoreFocus = useReturnFocus(() => open.value);
const tags = useTags(open);
const tagNames = computed(() => tags.data.value?.map((t) => t.tag) ?? []);

const selected = ref<string[]>([]);
const search = ref<string | null>('');
/** Only for what is typed, so the menu stays shut until then. */
const suggestions = computed(() => suggestTags(tagNames.value, search.value, selected.value));
const busy = ref(false);

watch(
  () => ui.tagsEntry,
  (entry) => {
    if (entry) selected.value = [...entry.tags];
  },
);

/** Typed tags are shown as they will be stored. */
function change(values: string[]) {
  selected.value = normaliseTags(values);
}

async function save() {
  const entry = ui.tagsEntry;
  if (!entry) return;
  busy.value = true;
  try {
    await actions.setTags(entry, selected.value);
    open.value = false;
  } catch (error) {
    ui.notify(error instanceof ApiError ? error.message : t('errors.generic'), true);
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <v-dialog v-model="open" max-width="520" @after-leave="restoreFocus">
    <v-card
      v-if="ui.tagsEntry"
      :title="t('tags.edit')"
      :subtitle="ui.tagsEntry.title ?? t('entries.untitled')"
    >
      <v-form @submit.prevent="save">
        <v-card-text>
          <v-combobox
            v-model:search="search"
            :model-value="selected"
            :items="suggestions"
            no-filter
            hide-selected
            :label="t('tags.title')"
            :hint="t('tags.hint', { n: MAX_TAGS_PER_ENTRY })"
            persistent-hint
            :delimiters="[',']"
            multiple
            chips
            closable-chips
            autofocus
            @update:model-value="change"
          />
        </v-card-text>
        <v-card-actions>
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
