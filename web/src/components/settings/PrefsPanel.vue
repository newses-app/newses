<script setup lang="ts">
import type { Prefs } from '@newses/shared';
import { FONT_KEYS, MAX_SCORE } from '@newses/shared/client';
import { computed, onBeforeUnmount, reactive, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { useDurations } from '../../composables/useDurations.ts';
import { usePrefs } from '../../composables/usePrefs.ts';
import { parseScore } from '../../lib/score.ts';
import { useUiStore } from '../../stores/ui.ts';

const { t, n } = useI18n();
const ui = useUiStore();
const { prefs, update } = usePrefs();
const { intervalItems, purgeItems } = useDurations();

const choices = <K extends keyof Prefs>(key: K, values: readonly Prefs[K][], prefix: string) =>
  computed(() => values.map((value) => ({ title: t(`${prefix}.${String(value)}`), value })));
const viewItems = choices('viewMode', ['adaptive', 'all', 'unread'], 'view');
const orderItems = choices('sortOrder', ['newest', 'oldest', 'title'], 'order');
const layoutItems = choices('layout', ['threePane', 'combined'], 'layout');
const fontItems = choices('articleFont', FONT_KEYS, 'reading.fonts');
const widthItems = choices('articleWidth', ['narrow', 'medium', 'wide', 'full'], 'reading.widths');
/** The slider shows changes as it moves (mouse or keys) and saves once it rests. */
const fontSize = ref<number | null>(null);
let saveSize: ReturnType<typeof setTimeout> | undefined;
function saveFontSize() {
  clearTimeout(saveSize);
  if (fontSize.value !== null) update({ articleFontSize: fontSize.value });
  fontSize.value = null;
}
function changeSize(value: number) {
  fontSize.value = value;
  clearTimeout(saveSize);
  saveSize = setTimeout(saveFontSize, 400);
}
onBeforeUnmount(saveFontSize);
const freshItems = computed(() =>
  [6, 12, 24, 48, 72, 168].map((hours) => ({
    title: t('time.hours', { n: hours }, hours),
    value: hours,
  })),
);

/** Score thresholds are typed, then saved on Enter or when the field loses focus. */
const thresholds = ['scoreHighlightAbove', 'scoreHideBelow'] as const;
type Threshold = (typeof thresholds)[number];
const thresholdText = reactive<Record<Threshold, string | null>>({
  scoreHighlightAbove: null,
  scoreHideBelow: null,
});
const invalidScore = computed(() => t('entries.scoreInvalid', { max: n(MAX_SCORE) }));
function saveThreshold(key: Threshold) {
  const text = thresholdText[key];
  thresholdText[key] = null;
  const value = text === null ? null : parseScore(text);
  if (value !== null && value !== prefs.value[key]) update({ [key]: value });
}

const switches = [
  'showContentPreview',
  'markReadOnScroll',
  'hideReadFeeds',
  'confirmCatchUp',
  'proxyImages',
  'keyboardShortcuts',
] as const;
</script>

<template>
  <section>
    <h2 class="text-title-large mb-4">{{ t('settings.reading') }}</h2>
    <v-row>
      <v-col cols="12" sm="6">
        <v-select
          :model-value="prefs.viewMode"
          :items="viewItems"
          :label="t('view.label')"
          @update:model-value="(v) => update({ viewMode: v })"
        />
      </v-col>
      <v-col cols="12" sm="6">
        <v-select
          :model-value="prefs.sortOrder"
          :items="orderItems"
          :label="t('order.label')"
          @update:model-value="(v) => update({ sortOrder: v })"
        />
      </v-col>
      <v-col cols="12" sm="6">
        <v-select
          :model-value="prefs.layout"
          :items="layoutItems"
          :label="t('layout.label')"
          @update:model-value="(v) => update({ layout: v })"
        />
      </v-col>
      <v-col cols="12" sm="6">
        <v-select
          :model-value="prefs.freshMaxAgeHours"
          :items="freshItems"
          :label="t('settings.freshAge')"
          @update:model-value="(v) => update({ freshMaxAgeHours: v })"
        />
      </v-col>
      <v-col v-for="key in thresholds" :key="key" cols="12" sm="6">
        <v-text-field
          :model-value="thresholdText[key] ?? String(prefs[key])"
          :label="t(`settings.${key}`)"
          :hint="key === 'scoreHideBelow' ? t('settings.scoreHideHint') : undefined"
          :persistent-hint="key === 'scoreHideBelow'"
          inputmode="numeric"
          :rules="[(v: string) => parseScore(v) !== null || invalidScore]"
          @update:model-value="(v) => (thresholdText[key] = v)"
          @blur="saveThreshold(key)"
          @keydown.enter="saveThreshold(key)"
        />
      </v-col>
    </v-row>
    <v-switch
      v-for="key in switches"
      :key="key"
      :model-value="prefs[key]"
      :label="t(`settings.${key}`)"
      color="primary"
      density="compact"
      hide-details
      @update:model-value="(v) => update({ [key]: Boolean(v) })"
    />

    <h2 class="text-title-large mt-8 mb-4">{{ t('reading.title') }}</h2>
    <v-row>
      <v-col cols="12" sm="6">
        <v-select
          :model-value="prefs.articleFont"
          :items="fontItems"
          :label="t('reading.font')"
          @update:model-value="(v) => update({ articleFont: v })"
        />
      </v-col>
      <v-col cols="12" sm="6">
        <v-select
          :model-value="prefs.articleWidth"
          :items="widthItems"
          :label="t('reading.width')"
          @update:model-value="(v) => update({ articleWidth: v })"
        />
      </v-col>
      <v-col cols="12">
        <v-slider
          :model-value="fontSize ?? prefs.articleFontSize"
          :label="t('reading.size')"
          :aria-label="t('reading.size')"
          :min="12"
          :max="28"
          :step="1"
          thumb-label
          @update:model-value="changeSize"
        />
      </v-col>
    </v-row>
    <div
      class="article-content reading-preview mb-8"
      :style="{ fontSize: fontSize === null ? undefined : `${fontSize / 16}rem` }"
      role="note"
      :aria-label="t('reading.preview')"
    >
      <p>{{ t('reading.sample') }}</p>
    </div>

    <h2 class="text-title-large mt-4 mb-1">{{ t('settings.updates') }}</h2>
    <p class="text-body-medium text-medium-emphasis mb-4">{{ t('settings.updatesHint') }}</p>
    <v-row>
      <v-col cols="12" sm="6">
        <v-select
          :model-value="prefs.updateIntervalMinutes"
          :items="intervalItems"
          :label="t('feeds.interval')"
          @update:model-value="(v) => update({ updateIntervalMinutes: v })"
        />
      </v-col>
      <v-col cols="12" sm="6">
        <v-select
          :model-value="prefs.purgeDays"
          :items="purgeItems"
          :label="t('feeds.purge')"
          @update:model-value="(v) => update({ purgeDays: v })"
        />
      </v-col>
    </v-row>

    <v-btn variant="tonal" class="mt-4" @click="ui.helpOpen = true">{{
      t('shortcuts.show')
    }}</v-btn>
  </section>
</template>

<style scoped>
.reading-preview {
  max-width: var(--article-width, 50rem);
  padding: 1rem;
  border: thin solid rgba(var(--v-border-color), var(--v-border-opacity));
  border-radius: 4px;
}
.reading-preview p {
  margin: 0;
}
</style>
