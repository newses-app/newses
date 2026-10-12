<script setup lang="ts">
import type {
  Entry,
  Filter,
  FilterAction,
  FilterActionType,
  FilterField,
  FilterRequest,
} from '@newses/shared';
import {
  FILTER_ACTIONS,
  FILTER_FIELDS,
  MAX_FILTER_PATTERN,
  MAX_SCORE,
} from '@newses/shared/client';
import {
  mdiArrowDown,
  mdiArrowUp,
  mdiDelete,
  mdiFilterOutline,
  mdiPencil,
  mdiPlay,
  mdiPlus,
} from '@mdi/js';
import { useQuery, useQueryClient } from '@tanstack/vue-query';
import { computed, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { api, ApiError } from '../../api.ts';
import { COUNTERS_KEY } from '../../composables/useCounters.ts';
import { ENTRIES_KEY } from '../../composables/useEntries.ts';
import { useCategories, useSubscriptions } from '../../composables/useFeeds.ts';
import { useLabels } from '../../composables/useLabels.ts';
import { useReturnFocus } from '../../composables/useReturnFocus.ts';
import { useUiStore } from '../../stores/ui.ts';

const FILTERS_KEY = ['filters'] as const;

interface RuleDraft {
  field: FilterField;
  pattern: string;
  inverse: boolean;
  /** `s<id>` for subscriptions, `c<id>` for categories. */
  scope: string[];
}

interface ActionDraft {
  type: FilterActionType;
  labelId: number | null;
  tag: string;
  score: number;
}

interface Draft {
  filter: Filter | null;
  title: string;
  enabled: boolean;
  matchAny: boolean;
  inverse: boolean;
  rules: RuleDraft[];
  actions: ActionDraft[];
}

const { t } = useI18n();
const ui = useUiStore();
const queryClient = useQueryClient();
const filters = useQuery({ queryKey: FILTERS_KEY, queryFn: () => api.filters.list() });
const subscriptions = useSubscriptions();
const categories = useCategories();
const labels = useLabels();

const editing = ref<Draft | null>(null);
const restoreFocus = useReturnFocus(() => editing.value !== null);
const busy = ref(false);
const preview = ref<{ checked: number; matched: number; matches: Entry[] } | null>(null);
const applying = ref<number | null>(null);

const fieldItems = computed(() =>
  FILTER_FIELDS.map((value) => ({ value, title: t(`filters.fields.${value}`) })),
);
const actionItems = computed(() =>
  FILTER_ACTIONS.map((value) => ({ value, title: t(`filters.actions.${value}`) })),
);
const scopeItems = computed(() => [
  ...(categories.data.value ?? []).map((c) => ({
    value: `c${String(c.id)}`,
    title: t('filters.categoryScope', { name: c.title }),
  })),
  ...(subscriptions.data.value ?? []).map((s) => ({ value: `s${String(s.id)}`, title: s.title })),
]);
const labelItems = computed(() =>
  (labels.data.value ?? []).map((l) => ({ value: l.id, title: l.caption })),
);

const newRule = (): RuleDraft => ({ field: 'title', pattern: '', inverse: false, scope: [] });
const newAction = (): ActionDraft => ({ type: 'markRead', labelId: null, tag: '', score: 0 });

function newFilter() {
  preview.value = null;
  editing.value = {
    filter: null,
    title: '',
    enabled: true,
    matchAny: false,
    inverse: false,
    rules: [newRule()],
    actions: [newAction()],
  };
}

function editFilter(filter: Filter) {
  preview.value = null;
  editing.value = {
    filter,
    title: filter.title,
    enabled: filter.enabled,
    matchAny: filter.matchAny,
    inverse: filter.inverse,
    rules: filter.rules.map((r) => ({
      field: r.field,
      pattern: r.pattern,
      inverse: r.inverse,
      scope: [
        ...r.categoryIds.map((id) => `c${String(id)}`),
        ...r.subscriptionIds.map((id) => `s${String(id)}`),
      ],
    })),
    actions: filter.actions.map((a) => ({
      type: a.type,
      labelId: a.type === 'label' ? a.labelId : null,
      tag: a.type === 'tag' ? a.tag : '',
      score: a.type === 'score' ? a.score : 0,
    })),
  };
}

const ids = (scope: string[], prefix: string) =>
  scope.filter((s) => s.startsWith(prefix)).map((s) => Number(s.slice(1)));

function toAction(action: ActionDraft): FilterAction {
  switch (action.type) {
    case 'label':
      return { type: 'label', labelId: action.labelId ?? 0 };
    case 'tag':
      return { type: 'tag', tag: action.tag.trim() };
    case 'score':
      return { type: 'score', score: Math.trunc(Number(action.score)) };
    default:
      return { type: action.type };
  }
}

function toRequest(draft: Draft): FilterRequest {
  return {
    title: draft.title.trim(),
    enabled: draft.enabled,
    matchAny: draft.matchAny,
    inverse: draft.inverse,
    rules: draft.rules.map((r) => ({
      field: r.field,
      pattern: r.pattern,
      inverse: r.inverse,
      categoryIds: ids(r.scope, 'c'),
      subscriptionIds: ids(r.scope, 's'),
    })),
    actions: draft.actions.map(toAction),
  };
}

const complete = computed(() => {
  const draft = editing.value;
  return (
    !!draft?.title.trim() &&
    draft.rules.length > 0 &&
    draft.rules.every((r) => r.pattern) &&
    draft.actions.length > 0 &&
    draft.actions.every(
      (a) => (a.type !== 'label' || a.labelId !== null) && (a.type !== 'tag' || a.tag.trim()),
    )
  );
});

async function run<T>(work: () => Promise<T>): Promise<T | undefined> {
  busy.value = true;
  try {
    return await work();
  } catch (error) {
    ui.notify(error instanceof ApiError ? error.message : t('errors.generic'), true);
    return undefined;
  } finally {
    busy.value = false;
  }
}

const refresh = () => queryClient.invalidateQueries({ queryKey: FILTERS_KEY });

async function save() {
  const draft = editing.value;
  if (!draft || !complete.value) return;
  const body = toRequest(draft);
  const saved = await run(() =>
    draft.filter ? api.filters.update(draft.filter.id, body) : api.filters.create(body),
  );
  if (saved) {
    editing.value = null;
    await refresh();
  }
}

async function test() {
  const draft = editing.value;
  if (!draft || !complete.value) return;
  preview.value = (await run(() => api.filters.test(toRequest(draft)))) ?? null;
}

async function move(filter: Filter, offset: number) {
  const order = (filters.data.value ?? []).map((f) => f.id);
  const index = order.indexOf(filter.id);
  const target = index + offset;
  if (target < 0 || target >= order.length) return;
  [order[index], order[target]] = [order[target] ?? filter.id, filter.id];
  await run(() => api.filters.reorder(order));
  await refresh();
}

async function apply(filter: Filter) {
  const confirmed = await ui.confirm(
    t('filters.apply'),
    t('filters.applyConfirm', { title: filter.title }),
    t('filters.apply'),
  );
  if (!confirmed) return;
  applying.value = filter.id;
  let checked = 0;
  let matched = 0;
  try {
    let cursor: string | undefined;
    do {
      const result = await api.filters.apply(filter.id, cursor);
      checked += result.checked;
      matched += result.matched;
      cursor = result.cursor ?? undefined;
    } while (cursor);
    ui.notify(t('filters.applied', { checked, matched }));
  } catch (error) {
    ui.notify(error instanceof ApiError ? error.message : t('errors.generic'), true);
  } finally {
    applying.value = null;
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: [ENTRIES_KEY] }),
      queryClient.invalidateQueries({ queryKey: COUNTERS_KEY }),
    ]);
  }
}

async function deleteFilter(filter: Filter) {
  const confirmed = await ui.confirm(
    t('filters.delete'),
    t('filters.deleteConfirm', { title: filter.title }),
    t('common.delete'),
  );
  if (!confirmed) return;
  await run(() => api.filters.delete(filter.id));
  await refresh();
}

async function toggle(filter: Filter, enabled: boolean) {
  await run(() => api.filters.update(filter.id, { ...filter, enabled }));
  await refresh();
}
</script>

<template>
  <section>
    <div class="d-flex flex-wrap ga-2 mb-6">
      <v-btn color="primary" variant="flat" :prepend-icon="mdiPlus" @click="newFilter">
        {{ t('filters.newFilter') }}
      </v-btn>
    </div>
    <h2 class="text-title-large mb-2">{{ t('filters.title') }}</h2>
    <p class="text-body-small text-medium-emphasis mb-4">{{ t('filters.hint') }}</p>
    <p v-if="filters.data.value?.length === 0" class="text-body-medium text-medium-emphasis">
      {{ t('filters.none') }}
    </p>
    <v-list v-else density="compact" :aria-label="t('filters.title')">
      <v-list-item
        v-for="(filter, index) in filters.data.value"
        :key="filter.id"
        :title="filter.title"
        :subtitle="
          t('filters.summary', { rules: filter.rules.length, actions: filter.actions.length })
        "
        :data-filter="filter.title"
      >
        <template #prepend>
          <v-switch
            :model-value="filter.enabled"
            :aria-label="t('filters.enabledNamed', { title: filter.title })"
            density="compact"
            hide-details
            color="primary"
            class="mr-2"
            @update:model-value="(v) => toggle(filter, !!v)"
          />
        </template>
        <template #append>
          <v-btn
            :icon="mdiArrowUp"
            size="small"
            variant="text"
            :disabled="index === 0"
            :aria-label="t('filters.moveUp', { title: filter.title })"
            @click="move(filter, -1)"
          />
          <v-btn
            :icon="mdiArrowDown"
            size="small"
            variant="text"
            :disabled="index === (filters.data.value?.length ?? 0) - 1"
            :aria-label="t('filters.moveDown', { title: filter.title })"
            @click="move(filter, 1)"
          />
          <v-btn
            :icon="mdiPlay"
            size="small"
            variant="text"
            :loading="applying === filter.id"
            :aria-label="t('filters.applyNamed', { title: filter.title })"
            @click="apply(filter)"
          />
          <v-btn
            :icon="mdiPencil"
            size="small"
            variant="text"
            :aria-label="t('filters.editNamed', { title: filter.title })"
            @click="editFilter(filter)"
          />
          <v-btn
            :icon="mdiDelete"
            size="small"
            variant="text"
            :aria-label="t('filters.deleteNamed', { title: filter.title })"
            @click="deleteFilter(filter)"
          />
        </template>
      </v-list-item>
    </v-list>

    <v-dialog
      :model-value="editing !== null"
      max-width="760"
      scrollable
      @update:model-value="(v) => !v && (editing = null)"
      @after-leave="restoreFocus"
    >
      <v-card v-if="editing" :title="editing.filter ? t('filters.edit') : t('filters.newFilter')">
        <v-card-text>
          <v-form id="filter-form" @submit.prevent="save">
            <v-text-field
              v-model="editing.title"
              :label="t('filters.name')"
              maxlength="200"
              autofocus
            />
            <div class="d-flex flex-wrap ga-4 align-center">
              <v-switch
                v-model="editing.enabled"
                :label="t('filters.enabled')"
                color="primary"
                hide-details
              />
              <v-select
                v-model="editing.matchAny"
                :items="[
                  { value: false, title: t('filters.matchAll') },
                  { value: true, title: t('filters.matchAny') },
                ]"
                :label="t('filters.match')"
                hide-details
                class="match"
              />
              <v-checkbox v-model="editing.inverse" :label="t('filters.inverse')" hide-details />
            </div>

            <h3 class="text-title-medium mt-6 mb-2">{{ t('filters.rules') }}</h3>
            <p class="text-body-small text-medium-emphasis mb-2">{{ t('filters.patternHint') }}</p>
            <fieldset
              v-for="(rule, index) in editing.rules"
              :key="index"
              class="part mb-2"
              :aria-label="t('filters.ruleN', { n: index + 1 })"
            >
              <v-row dense>
                <v-col cols="12" sm="4">
                  <v-select
                    v-model="rule.field"
                    :items="fieldItems"
                    :label="t('filters.field')"
                    hide-details
                  />
                </v-col>
                <v-col cols="12" sm="8">
                  <v-text-field
                    v-model="rule.pattern"
                    :label="t('filters.pattern')"
                    :maxlength="MAX_FILTER_PATTERN"
                    class="pattern"
                    hide-details
                  />
                </v-col>
                <v-col cols="12" sm="8">
                  <v-autocomplete
                    v-model="rule.scope"
                    :items="scopeItems"
                    :label="t('filters.scope')"
                    :placeholder="t('filters.allFeeds')"
                    persistent-placeholder
                    multiple
                    chips
                    closable-chips
                    hide-details
                  />
                </v-col>
                <v-col cols="12" sm="4" class="d-flex align-center">
                  <v-checkbox
                    v-model="rule.inverse"
                    :label="t('filters.notMatching')"
                    hide-details
                  />
                  <v-spacer />
                  <v-btn
                    :icon="mdiDelete"
                    size="small"
                    variant="text"
                    :disabled="editing.rules.length === 1"
                    :aria-label="t('filters.removeRule', { n: index + 1 })"
                    @click="editing.rules.splice(index, 1)"
                  />
                </v-col>
              </v-row>
            </fieldset>
            <v-btn variant="text" :prepend-icon="mdiPlus" @click="editing.rules.push(newRule())">
              {{ t('filters.addRule') }}
            </v-btn>

            <h3 class="text-title-medium mt-6 mb-2">{{ t('filters.actionsTitle') }}</h3>
            <fieldset
              v-for="(action, index) in editing.actions"
              :key="index"
              class="part mb-2"
              :aria-label="t('filters.actionN', { n: index + 1 })"
            >
              <v-row dense align="center">
                <v-col cols="12" sm="5">
                  <v-select
                    v-model="action.type"
                    :items="actionItems"
                    :label="t('filters.action')"
                    hide-details
                  />
                </v-col>
                <v-col cols="10" sm="6">
                  <v-select
                    v-if="action.type === 'label'"
                    v-model="action.labelId"
                    :items="labelItems"
                    :label="t('filters.label')"
                    :no-data-text="t('labels.none')"
                    hide-details
                  />
                  <v-text-field
                    v-else-if="action.type === 'tag'"
                    v-model="action.tag"
                    :label="t('filters.tag')"
                    maxlength="64"
                    hide-details
                  />
                  <v-text-field
                    v-else-if="action.type === 'score'"
                    v-model.number="action.score"
                    type="number"
                    :min="-MAX_SCORE"
                    :max="MAX_SCORE"
                    :label="t('filters.scoreChange')"
                    hide-details
                  />
                </v-col>
                <v-col cols="2" sm="1">
                  <v-btn
                    :icon="mdiDelete"
                    size="small"
                    variant="text"
                    :disabled="editing.actions.length === 1"
                    :aria-label="t('filters.removeAction', { n: index + 1 })"
                    @click="editing.actions.splice(index, 1)"
                  />
                </v-col>
              </v-row>
            </fieldset>
            <v-btn
              variant="text"
              :prepend-icon="mdiPlus"
              @click="editing.actions.push(newAction())"
            >
              {{ t('filters.addAction') }}
            </v-btn>

            <section v-if="preview" class="mt-6" aria-live="polite">
              <h3 class="text-title-medium mb-1">{{ t('filters.testResults') }}</h3>
              <p class="text-body-medium mb-2">
                {{
                  t('filters.testSummary', { matched: preview.matched, checked: preview.checked })
                }}
              </p>
              <v-list density="compact" :aria-label="t('filters.testResults')">
                <v-list-item
                  v-for="entry in preview.matches"
                  :key="entry.id"
                  :title="entry.title ?? t('entries.untitled')"
                  :subtitle="entry.feedTitle ?? ''"
                />
              </v-list>
            </section>
          </v-form>
        </v-card-text>
        <v-card-actions>
          <v-btn
            :prepend-icon="mdiFilterOutline"
            :disabled="!complete"
            :loading="busy"
            @click="test"
          >
            {{ t('filters.test') }}
          </v-btn>
          <v-spacer />
          <v-btn @click="editing = null">{{ t('common.cancel') }}</v-btn>
          <v-btn
            type="submit"
            form="filter-form"
            color="primary"
            variant="flat"
            :loading="busy"
            :disabled="!complete"
          >
            {{ t('common.save') }}
          </v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>
  </section>
</template>

<style scoped>
.part {
  border: 1px solid rgba(var(--v-border-color), var(--v-border-opacity));
  border-radius: 4px;
  padding: 8px;
}
.match {
  max-width: 260px;
}
.pattern :deep(input) {
  font-family: monospace;
}
</style>
