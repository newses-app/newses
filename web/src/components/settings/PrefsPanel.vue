<script setup lang="ts">
import type { Prefs } from '@rss-reader/shared';
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { useDurations } from '../../composables/useDurations.ts';
import { usePrefs } from '../../composables/usePrefs.ts';
import { useUiStore } from '../../stores/ui.ts';

const { t } = useI18n();
const ui = useUiStore();
const { prefs, update } = usePrefs();
const { intervalItems, purgeItems } = useDurations();

const choices = <K extends keyof Prefs>(key: K, values: readonly Prefs[K][], prefix: string) =>
  computed(() => values.map((value) => ({ title: t(`${prefix}.${String(value)}`), value })));
const viewItems = choices('viewMode', ['adaptive', 'all', 'unread'], 'view');
const orderItems = choices('sortOrder', ['newest', 'oldest', 'title'], 'order');
const layoutItems = choices('layout', ['threePane', 'combined'], 'layout');
const themeItems = choices('theme', ['system', 'light', 'dark'], 'theme');
const freshItems = computed(() =>
  [6, 12, 24, 48, 72, 168].map((hours) => ({
    title: t('time.hours', { n: hours }, hours),
    value: hours,
  })),
);

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

    <h2 class="text-title-large mt-8 mb-4">{{ t('settings.appearance') }}</h2>
    <v-row>
      <v-col cols="12" sm="6">
        <v-select
          :model-value="prefs.theme"
          :items="themeItems"
          :label="t('theme.label')"
          @update:model-value="(v) => update({ theme: v })"
        />
      </v-col>
    </v-row>

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
