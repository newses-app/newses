<script setup lang="ts">
import { MAX_BINDINGS_PER_ACTION } from '@rss-reader/shared/client';
import { mdiPlus, mdiRestore } from '@mdi/js';
import { computed, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { usePrefs } from '../../composables/usePrefs.ts';
import { useReturnFocus } from '../../composables/useReturnFocus.ts';
import {
  ACTION_GROUPS,
  type BindingOverrides,
  bindableKey,
  clashingActions,
  DEFAULT_BINDINGS,
  displayKeys,
  effectiveBindings,
  findConflicts,
  type ShortcutAction,
  withOverride,
} from '../../lib/shortcuts.ts';
import { useUiStore } from '../../stores/ui.ts';

const { t } = useI18n();
const ui = useUiStore();
const { prefs, update } = usePrefs();

const overrides = computed(() => prefs.value.shortcutBindings);
const bindings = computed(() => effectiveBindings(overrides.value));
const conflicts = computed(() => findConflicts(bindings.value));
const actionName = (action: ShortcutAction) => t(`shortcuts.actions.${action}`);
const keysText = (sequence: string) => displayKeys(sequence).join(' ');

const save = (next: BindingOverrides) => update({ shortcutBindings: next });

function remove(action: ShortcutAction, sequence: string) {
  save(
    withOverride(
      overrides.value,
      action,
      bindings.value[action].filter((s) => s !== sequence),
    ),
  );
}

const reset = (action: ShortcutAction) =>
  save(withOverride(overrides.value, action, DEFAULT_BINDINGS[action]));

async function resetAll() {
  if (
    await ui.confirm(
      t('shortcuts.resetAll'),
      t('shortcuts.resetAllConfirm'),
      t('shortcuts.resetAll'),
    )
  )
    save({});
}

/** The action being given a new sequence, and the keys pressed so far. */
const recording = ref<{ action: ShortcutAction; keys: string[] } | null>(null);
const restoreFocus = useReturnFocus(() => recording.value !== null);
const sequence = computed(() => recording.value?.keys.join(' ') ?? '');
const clashes = computed(() =>
  recording.value && sequence.value
    ? clashingActions(bindings.value, sequence.value, recording.value.action)
    : [],
);
/** Actions bound to exactly this sequence give it up on save; chord-prefix clashes block it. */
const moved = computed(() =>
  clashes.value.filter((a) => bindings.value[a].includes(sequence.value)),
);
const blocked = computed(() => clashes.value.filter((a) => !moved.value.includes(a)));
const duplicate = computed(
  () => !!recording.value && bindings.value[recording.value.action].includes(sequence.value),
);

/** Two keys make a chord; a third key starts over. */
function capture(event: KeyboardEvent) {
  const key = bindableKey(event);
  if (!key || key === 'Escape' || !recording.value) return;
  event.preventDefault();
  const keys = recording.value.keys.length >= 2 ? [] : recording.value.keys;
  recording.value = { ...recording.value, keys: [...keys, key] };
}

function saveRecording() {
  const value = recording.value;
  if (!value || !sequence.value || blocked.value.length > 0 || duplicate.value) return;
  let next = overrides.value;
  for (const other of moved.value)
    next = withOverride(
      next,
      other,
      bindings.value[other].filter((s) => s !== sequence.value),
    );
  next = withOverride(next, value.action, [...bindings.value[value.action], sequence.value]);
  save(next);
  recording.value = null;
}
</script>

<template>
  <section>
    <v-alert
      v-if="!prefs.keyboardShortcuts"
      type="info"
      variant="tonal"
      density="compact"
      class="mb-4"
    >
      {{ t('shortcuts.disabledHint') }}
    </v-alert>
    <v-alert v-if="conflicts.length" type="warning" variant="tonal" density="compact" class="mb-4">
      {{
        t('shortcuts.conflicts', {
          list: conflicts
            .map((c) => `${keysText(c.sequence)}: ${c.actions.map(actionName).join(', ')}`)
            .join('; '),
        })
      }}
    </v-alert>
    <p class="text-body-medium mb-4">{{ t('shortcuts.settingsHint') }}</p>
    <div v-for="group in ACTION_GROUPS" :key="group.group" class="mb-6">
      <h2 class="text-title-large mb-2">{{ t(`shortcuts.groups.${group.group}`) }}</h2>
      <v-table density="compact">
        <thead>
          <tr>
            <th scope="col">{{ t('shortcuts.action') }}</th>
            <th scope="col">{{ t('shortcuts.keys') }}</th>
            <th scope="col" class="text-end">{{ t('settings.actions') }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="action in group.actions" :key="action">
            <td>{{ actionName(action) }}</td>
            <td>
              <span v-if="bindings[action].length === 0" class="text-medium-emphasis">
                {{ t('shortcuts.unbound') }}
              </span>
              <v-chip
                v-for="s in bindings[action]"
                :key="s"
                size="small"
                class="me-1 my-1"
                closable
                :close-label="
                  t('shortcuts.removeNamed', { keys: keysText(s), action: actionName(action) })
                "
                @click:close="remove(action, s)"
              >
                <kbd v-for="(key, index) in displayKeys(s)" :key="index">{{ key }}</kbd>
              </v-chip>
            </td>
            <td class="text-end text-no-wrap">
              <v-btn
                :icon="mdiPlus"
                size="small"
                variant="text"
                :disabled="bindings[action].length >= MAX_BINDINGS_PER_ACTION"
                :aria-label="t('shortcuts.addNamed', { action: actionName(action) })"
                @click="recording = { action, keys: [] }"
              />
              <v-btn
                :icon="mdiRestore"
                size="small"
                variant="text"
                :disabled="!(action in overrides)"
                :aria-label="t('shortcuts.resetNamed', { action: actionName(action) })"
                @click="reset(action)"
              />
            </td>
          </tr>
        </tbody>
      </v-table>
    </div>
    <v-btn variant="tonal" :prepend-icon="mdiRestore" @click="resetAll">
      {{ t('shortcuts.resetAll') }}
    </v-btn>

    <v-dialog
      :model-value="recording !== null"
      max-width="480"
      @update:model-value="(v) => !v && (recording = null)"
      @after-leave="restoreFocus"
    >
      <v-card v-if="recording" :title="t('shortcuts.add')" :subtitle="actionName(recording.action)">
        <v-card-text>
          <p class="text-body-medium mb-4">{{ t('shortcuts.recordHint') }}</p>
          <v-text-field
            :model-value="keysText(sequence)"
            :label="t('shortcuts.keys')"
            :placeholder="t('shortcuts.pressKeys')"
            persistent-placeholder
            readonly
            autofocus
            @keydown="capture"
          />
          <v-alert v-if="blocked.length" type="error" variant="tonal" density="compact">
            {{ t('shortcuts.blocked', { actions: blocked.map(actionName).join(', ') }) }}
          </v-alert>
          <v-alert v-else-if="duplicate" type="info" variant="tonal" density="compact">
            {{ t('shortcuts.duplicate') }}
          </v-alert>
          <v-alert v-else-if="moved.length" type="warning" variant="tonal" density="compact">
            {{ t('shortcuts.moved', { actions: moved.map(actionName).join(', ') }) }}
          </v-alert>
        </v-card-text>
        <v-card-actions>
          <v-btn :disabled="!sequence" @click="recording = { ...recording, keys: [] }">
            {{ t('shortcuts.clear') }}
          </v-btn>
          <v-spacer />
          <v-btn @click="recording = null">{{ t('common.cancel') }}</v-btn>
          <v-btn
            color="primary"
            variant="flat"
            :disabled="!sequence || blocked.length > 0 || duplicate"
            @click="saveRecording"
          >
            {{ moved.length ? t('shortcuts.replace') : t('common.save') }}
          </v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>
  </section>
</template>

<style scoped>
kbd {
  font-family: inherit;
}
kbd + kbd {
  margin-inline-start: 0.35em;
}
</style>
