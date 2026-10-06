<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { useReturnFocus } from '../../composables/useReturnFocus.ts';
import { useUiStore } from '../../stores/ui.ts';

const ui = useUiStore();
const { t } = useI18n();
const open = computed({
  get: () => ui.confirmRequest !== null,
  set: (value) => {
    if (!value) ui.confirmRequest?.resolve(false);
  },
});
const restoreFocus = useReturnFocus(() => open.value);
</script>

<template>
  <v-dialog v-model="open" max-width="420" @after-leave="restoreFocus">
    <v-card
      v-if="ui.confirmRequest"
      :title="ui.confirmRequest.title"
      :text="ui.confirmRequest.text"
    >
      <v-card-actions>
        <v-spacer />
        <v-btn @click="ui.confirmRequest.resolve(false)">{{ t('common.cancel') }}</v-btn>
        <v-btn color="primary" variant="flat" autofocus @click="ui.confirmRequest.resolve(true)">
          {{ ui.confirmRequest.action }}
        </v-btn>
      </v-card-actions>
    </v-card>
  </v-dialog>
</template>
