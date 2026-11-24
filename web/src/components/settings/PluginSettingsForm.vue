<script setup lang="ts">
import type { PluginSettingsState } from '@newses/shared';
import { mdiClose, mdiDelete, mdiPlus } from '@mdi/js';
import { computed, reactive, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { useSubscriptions } from '../../composables/useFeeds.ts';
import { useOnlineOnly } from '../../composables/useOnlineOnly.ts';
import {
  blankItem,
  type FormField,
  formFields,
  initialValues,
  settingsChange,
} from '../../lib/plugin-form.ts';

const props = defineProps<{
  /** The scope's settings as JSON Schema. */
  schema: Record<string, unknown>;
  state: PluginSettingsState;
  /** The plugin's message for a key, else the fallback. */
  text: (key: string, fallback: string) => string;
  /** Hosts URL settings may be on. */
  approvedHosts: string[];
  /** While the settings are being saved. */
  saving?: boolean;
  /** Names the form for assistive technology. */
  label: string;
}>();
const emit = defineEmits<{ save: [settings: Record<string, unknown>] }>();

const { t } = useI18n();
const { online, whenOnline } = useOnlineOnly();

const fields = computed(() => formFields(props.schema));
const subscriptions = useSubscriptions();
/** The user's subscriptions to pick from, and any saved one they have since left. */
const feedItems = (f: FormField) => {
  const known = (subscriptions.data.value ?? []).map((s) => ({ value: s.id, title: s.title }));
  const ids = new Set(known.map((item) => item.value));
  const gone = (values[f.name] as number[])
    .filter((id) => !ids.has(id))
    .map((id) => ({ value: id, title: t('plugins.feedGone', { id }) }));
  return [...known, ...gone];
};
const values = reactive<Record<string, unknown>>({});
const cleared = ref(new Set<string>());

function reset() {
  for (const key of Object.keys(values)) Reflect.deleteProperty(values, key);
  Object.assign(values, initialValues(fields.value, props.state.settings));
  cleared.value = new Set();
}
watch(() => [props.schema, props.state], reset, { immediate: true });

const label = (f: FormField, parent?: FormField) =>
  parent
    ? props.text(`settings.${parent.name}.item.${f.name}`, f.name)
    : props.text(`settings.${f.name}`, f.name);
const hint = (f: FormField) => {
  const own = props.text(`settings.${f.name}.hint`, '');
  if (own || f.kind !== 'url') return own;
  return props.approvedHosts.length > 0
    ? t('plugins.urlHint', { hosts: props.approvedHosts.join(', ') })
    : t('plugins.urlNoHosts');
};
const options = (f: FormField) =>
  f.options.map((value) => ({
    value,
    title: props.text(`settings.${f.name}.option.${value}`, value),
  }));
const isSet = (f: FormField) =>
  props.state.secretsSet.includes(f.name) && !cleared.value.has(f.name);
const items = (f: FormField) => values[f.name] as Record<string, unknown>[];

function clearSecret(f: FormField) {
  cleared.value = new Set([...cleared.value, f.name]);
  values[f.name] = '';
}

const save = whenOnline(() => {
  emit('save', settingsChange(fields.value, values, props.state.settings, cleared.value));
});
</script>

<template>
  <v-form :aria-label="label" @submit.prevent="save">
    <template v-for="f in fields" :key="f.name">
      <v-switch
        v-if="f.kind === 'boolean'"
        v-model="values[f.name]"
        :label="label(f)"
        :hint="hint(f)"
        :persistent-hint="!!hint(f)"
        color="primary"
        class="mb-2"
      />
      <v-select
        v-else-if="f.kind === 'select'"
        v-model="values[f.name]"
        :items="options(f)"
        :label="label(f)"
        :hint="hint(f)"
        :persistent-hint="!!hint(f)"
        :clearable="f.nullable"
        class="mb-2"
      />
      <v-textarea
        v-else-if="f.kind === 'multiline'"
        v-model="values[f.name] as string"
        :label="label(f)"
        :hint="hint(f)"
        :persistent-hint="!!hint(f)"
        auto-grow
        rows="3"
        dir="auto"
        class="mb-2"
      />
      <div v-else-if="f.kind === 'secret'" class="d-flex align-start ga-2 mb-2">
        <v-text-field
          v-model="values[f.name] as string"
          :label="label(f)"
          :hint="
            isSet(f)
              ? t('plugins.secretSet')
              : cleared.has(f.name)
                ? t('plugins.secretCleared')
                : hint(f)
          "
          persistent-hint
          type="password"
          autocomplete="off"
          dir="ltr"
        />
        <v-btn
          v-if="isSet(f) && !f.required"
          :icon="mdiClose"
          variant="text"
          :aria-label="t('plugins.clearSecret', { name: label(f) })"
          @click="clearSecret(f)"
        />
      </div>
      <v-text-field
        v-else-if="f.kind === 'url'"
        v-model="values[f.name] as string"
        :label="label(f)"
        :hint="hint(f)"
        persistent-hint
        type="url"
        dir="ltr"
        class="mb-2"
      />
      <v-text-field
        v-else-if="f.kind === 'number'"
        v-model="values[f.name] as string"
        :label="label(f)"
        :hint="hint(f)"
        :persistent-hint="!!hint(f)"
        type="number"
        :step="f.integer ? 1 : 'any'"
        dir="ltr"
        class="mb-2"
      />
      <v-text-field
        v-else-if="f.kind === 'text'"
        v-model="values[f.name] as string"
        :label="label(f)"
        :hint="hint(f)"
        :persistent-hint="!!hint(f)"
        dir="auto"
        class="mb-2"
      />
      <v-autocomplete
        v-else-if="f.kind === 'feeds'"
        v-model="values[f.name] as number[]"
        :items="feedItems(f)"
        :label="label(f)"
        :hint="hint(f)"
        :persistent-hint="!!hint(f)"
        :placeholder="t('plugins.noFeeds')"
        persistent-placeholder
        multiple
        chips
        closable-chips
        class="mb-2"
      >
        <template #chip="{ props: chip, item }">
          <v-chip v-bind="chip"
            ><bdi>{{ item.title }}</bdi></v-chip
          >
        </template>
      </v-autocomplete>
      <fieldset v-else-if="f.kind === 'list'" class="plugin-list mb-4">
        <legend class="text-body-large">{{ label(f) }}</legend>
        <p v-if="hint(f)" class="text-body-small text-medium-emphasis mb-2">{{ hint(f) }}</p>
        <div
          v-for="(item, index) in items(f)"
          :key="index"
          class="d-flex flex-wrap align-center ga-2 mb-2"
        >
          <template v-for="p in f.item" :key="p.name">
            <v-switch
              v-if="p.kind === 'boolean'"
              v-model="item[p.name]"
              :label="label(p, f)"
              color="primary"
              hide-details
            />
            <v-select
              v-else-if="p.kind === 'select'"
              v-model="item[p.name] as string"
              :items="p.options"
              :label="label(p, f)"
              hide-details
              class="plugin-list-field"
            />
            <v-text-field
              v-else
              v-model="item[p.name] as string"
              :label="label(p, f)"
              :type="p.kind === 'number' ? 'number' : p.kind === 'url' ? 'url' : 'text'"
              :dir="p.kind === 'text' || p.kind === 'multiline' ? 'auto' : 'ltr'"
              hide-details
              class="plugin-list-field"
            />
          </template>
          <v-btn
            :icon="mdiDelete"
            variant="text"
            :aria-label="t('plugins.removeItem', { number: index + 1 })"
            @click="items(f).splice(index, 1)"
          />
        </div>
        <v-btn
          variant="tonal"
          size="small"
          :prepend-icon="mdiPlus"
          @click="items(f).push(blankItem(f))"
        >
          {{ t('plugins.addItem') }}
        </v-btn>
      </fieldset>
      <p v-else class="text-body-medium text-medium-emphasis mb-2">
        {{ t('plugins.unsupported', { name: label(f) }) }}
      </p>
    </template>
    <v-btn type="submit" color="primary" variant="flat" :loading="saving" :aria-disabled="!online">
      {{ t('plugins.save') }}
    </v-btn>
  </v-form>
</template>

<style scoped>
.plugin-list {
  border: none;
  padding: 0;
  margin: 0;
}

.plugin-list-field {
  min-inline-size: 12rem;
  flex: 1 1 12rem;
}
</style>
