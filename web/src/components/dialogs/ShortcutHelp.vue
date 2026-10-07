<script setup lang="ts">
import { computed, onBeforeUnmount, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { useReturnFocus } from '../../composables/useReturnFocus.ts';
import { usePrefs } from '../../composables/usePrefs.ts';
import { ACTION_GROUPS, displayKeys, effectiveBindings } from '../../lib/shortcuts.ts';
import { useUiStore } from '../../stores/ui.ts';

const ui = useUiStore();
const { t } = useI18n();
const { prefs } = usePrefs();
const bindings = computed(() => effectiveBindings(prefs.value.shortcutBindings));
// Escape closes the help even before the dialog has taken focus (it opens from a key press).
const onKeyDown = (event: KeyboardEvent) => {
  if (event.key === 'Escape') ui.helpOpen = false;
};
watch(
  () => ui.helpOpen,
  (open) => {
    if (open) window.addEventListener('keydown', onKeyDown);
    else window.removeEventListener('keydown', onKeyDown);
  },
);
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeyDown);
});
const restoreFocus = useReturnFocus(() => ui.helpOpen);
</script>

<template>
  <v-dialog v-model="ui.helpOpen" max-width="760" scrollable @after-leave="restoreFocus">
    <v-card :title="t('shortcuts.title')">
      <!-- Focusable so keyboard users can scroll a long list. -->
      <v-card-text tabindex="0">
        <v-row>
          <v-col v-for="group in ACTION_GROUPS" :key="group.group" cols="12" sm="6">
            <h3 class="text-title-small mb-2">{{ t(`shortcuts.groups.${group.group}`) }}</h3>
            <table class="w-100 text-body-medium">
              <tbody>
                <template v-for="action in group.actions" :key="action">
                  <tr v-for="sequence in bindings[action]" :key="sequence">
                    <td class="py-1 pe-4 text-no-wrap">
                      <template v-for="(key, index) in displayKeys(sequence)" :key="index">
                        <kbd>{{ key }}</kbd
                        ><span v-if="index < displayKeys(sequence).length - 1"> </span>
                      </template>
                    </td>
                    <td class="py-1">{{ t(`shortcuts.actions.${action}`) }}</td>
                  </tr>
                </template>
              </tbody>
            </table>
          </v-col>
        </v-row>
      </v-card-text>
      <v-card-actions>
        <v-spacer />
        <v-btn @click="ui.helpOpen = false">{{ t('common.close') }}</v-btn>
      </v-card-actions>
    </v-card>
  </v-dialog>
</template>

<style scoped>
kbd {
  display: inline-block;
  min-width: 1.6em;
  padding: 0 0.35em;
  border: 1px solid rgba(var(--v-theme-on-surface), 0.3);
  border-radius: 4px;
  font-family: inherit;
  text-align: center;
}
</style>
