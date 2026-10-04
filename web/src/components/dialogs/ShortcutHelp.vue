<script setup lang="ts">
import { onBeforeUnmount, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { SHORTCUT_GROUPS } from '../../lib/shortcuts.ts';
import { useUiStore } from '../../stores/ui.ts';

const ui = useUiStore();
const { t } = useI18n();
const KEY_NAMES: Record<string, string> = { ArrowDown: '↓', ArrowUp: '↑', Escape: 'Esc' };
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
const keys = (sequence: string) => sequence.split(' ').map((key) => KEY_NAMES[key] ?? key);
</script>

<template>
  <v-dialog v-model="ui.helpOpen" max-width="760" scrollable>
    <v-card :title="t('shortcuts.title')">
      <v-card-text>
        <v-row>
          <v-col v-for="group in SHORTCUT_GROUPS" :key="group.group" cols="12" sm="6">
            <h3 class="text-title-small mb-2">{{ t(`shortcuts.groups.${group.group}`) }}</h3>
            <table class="w-100 text-body-medium">
              <tbody>
                <tr v-for="[sequence, action] in group.bindings" :key="sequence">
                  <td class="py-1 pe-4 text-no-wrap">
                    <template v-for="(key, index) in keys(sequence)" :key="index">
                      <kbd>{{ key }}</kbd
                      ><span v-if="index < keys(sequence).length - 1"> </span>
                    </template>
                  </td>
                  <td class="py-1">{{ t(`shortcuts.actions.${action}`) }}</td>
                </tr>
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
