<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { useRouter } from 'vue-router';
import { useReturnFocus } from '../../composables/useReturnFocus.ts';
import { useTags } from '../../composables/useTags.ts';
import { streamPath, tagKey } from '../../lib/streams.ts';
import { useUiStore } from '../../stores/ui.ts';

const ui = useUiStore();
const router = useRouter();
const { t } = useI18n();

const restoreFocus = useReturnFocus(() => ui.tagPickerOpen);
const tags = useTags(() => ui.tagPickerOpen);
const items = computed(
  () =>
    tags.data.value?.map(({ tag, count }) => ({
      title: tag,
      value: tag,
      subtitle: t('tags.count', { n: count }, count),
    })) ?? [],
);

function go(tag: string | null) {
  if (!tag) return;
  ui.tagPickerOpen = false;
  void router.push(streamPath(tagKey(tag)));
}
</script>

<template>
  <v-dialog v-model="ui.tagPickerOpen" max-width="440" @after-leave="restoreFocus">
    <v-card :title="t('tags.browse')">
      <v-card-text>
        <p v-if="tags.data.value?.length === 0" class="text-body-medium text-medium-emphasis">
          {{ t('tags.none') }}
        </p>
        <v-autocomplete
          v-else
          :items="items"
          :item-props="true"
          :label="t('tags.search')"
          :loading="tags.isPending.value"
          autofocus
          auto-select-first
          @update:model-value="go"
        />
      </v-card-text>
      <v-card-actions>
        <v-spacer />
        <v-btn @click="ui.tagPickerOpen = false">{{ t('common.close') }}</v-btn>
      </v-card-actions>
    </v-card>
  </v-dialog>
</template>
