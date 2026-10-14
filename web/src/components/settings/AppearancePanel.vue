<script setup lang="ts">
import type { PartialThemeTokens, Prefs, ThemePalette } from '@newses/shared';
import {
  BUILTIN_THEME_KEYS,
  BUILTIN_THEMES,
  FONT_KEYS,
  MAX_FONT_SCALE,
  MIN_FONT_SCALE,
  THEME_BORDERS,
  THEME_DENSITIES,
  THEME_ELEVATIONS,
  THEME_RADII,
  THEME_STYLES,
} from '@newses/shared/client';
import { mdiAlertCircleOutline } from '@mdi/js';
import { computed, onBeforeUnmount } from 'vue';
import { useI18n } from 'vue-i18n';
import { useTheme } from 'vuetify';
import { adjustmentsPreview } from '../../composables/useAppearance.ts';
import { usePrefs } from '../../composables/usePrefs.ts';
import { contrastIssues, mergeAdjustments, themeTokens } from '../../lib/appearance.ts';
import { useUiStore } from '../../stores/ui.ts';

const { t, n } = useI18n();
const ui = useUiStore();
const vuetifyTheme = useTheme();
const { prefs, update } = usePrefs();

const COLORS = [
  'background',
  'surface',
  'text',
  'primary',
  'star',
  'error',
  'warning',
  'success',
] as const satisfies readonly (keyof ThemePalette)[];
/** Shown on each theme's card, over its background. */
const SWATCHES = ['surface', 'text', 'primary', 'star'] as const;

const options = <T extends string>(values: readonly T[], label: (value: T) => string) =>
  computed(() => values.map((value) => ({ title: label(value), value })));
const modeItems = options(['system', 'light', 'dark'] as const, (mode) => t(`theme.${mode}`));
const uiFontItems = options(FONT_KEYS, (font) =>
  font === 'default' ? t('appearance.standard') : t(`reading.fonts.${font}`),
);
const articleFontItems = options(FONT_KEYS, (font) =>
  font === 'default' ? t('appearance.sameAsUi') : t(`reading.fonts.${font}`),
);
const styleItems = options(THEME_STYLES, (style) => t(`appearance.styles.${style}`));
const radiusItems = options(THEME_RADII, (radius) => t(`appearance.radii.${radius}`));
const densityItems = options(THEME_DENSITIES, (density) => t(`appearance.densities.${density}`));
const borderItems = options(THEME_BORDERS, (border) => t(`appearance.borders.${border}`));
const elevationItems = options(THEME_ELEVATIONS, (elevation) =>
  t(`appearance.elevations.${elevation}`),
);

/** The palette being edited is the one of the mode on screen. */
const mode = computed(() => (vuetifyTheme.current.value.dark ? 'dark' : 'light'));

/** Adjustments show as they change and save once they rest, like the text size slider. */
const adjustments = computed(() => adjustmentsPreview.value ?? prefs.value.themeAdjustments);
const adjusted = computed(() => Object.keys(adjustments.value).length > 0);
let saveTimer: ReturnType<typeof setTimeout> | undefined;
function saveAdjustments() {
  clearTimeout(saveTimer);
  if (adjustmentsPreview.value !== null) update({ themeAdjustments: adjustmentsPreview.value });
  adjustmentsPreview.value = null;
}
function adjust(change: PartialThemeTokens) {
  adjustmentsPreview.value = mergeAdjustments(adjustments.value, change);
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveAdjustments, 400);
}
onBeforeUnmount(saveAdjustments);

function discardAdjustments() {
  clearTimeout(saveTimer);
  adjustmentsPreview.value = null;
}

function reset() {
  discardAdjustments();
  update({ themeAdjustments: {} });
}

/** The theme as shown, adjustments included. */
const tokens = computed(() =>
  themeTokens({
    appearanceTheme: prefs.value.appearanceTheme,
    themeAdjustments: adjustments.value,
  }),
);
const palette = computed(() => tokens.value.palette[mode.value]);
const issues = computed(() => new Map(contrastIssues(palette.value).map((i) => [i.color, i])));

function lowContrast(color: keyof ThemePalette): string | undefined {
  const issue = issues.value.get(color);
  return (
    issue && t('appearance.lowContrast', { ratio: issue.ratio.toFixed(1), min: String(issue.min) })
  );
}

function setColor(color: keyof ThemePalette, value: string) {
  if (/^#[0-9a-f]{6}$/i.test(value))
    adjust({ palette: { [mode.value]: { [color]: value.toLowerCase() } } });
}

const builtIn = computed(() =>
  BUILTIN_THEME_KEYS.map((key) => ({
    key,
    name: t(`appearance.themes.${key}`),
    palette: BUILTIN_THEMES[key].palette[mode.value],
  })),
);

/** Adjustments belong to the theme they were made on, so picking another discards them. */
async function pick(value: unknown) {
  const theme = value as Prefs['appearanceTheme'] | null;
  if (theme === null || theme === prefs.value.appearanceTheme) return;
  if (
    adjusted.value &&
    !(await ui.confirm(
      t('appearance.discardTitle'),
      t('appearance.discardText'),
      t('appearance.discard'),
    ))
  )
    return;
  discardAdjustments();
  update({ appearanceTheme: theme, themeAdjustments: {} });
}
</script>

<template>
  <section>
    <h2 class="text-title-large mb-4">{{ t('appearance.theme') }}</h2>
    <v-row>
      <v-col cols="12" sm="6">
        <v-select
          :model-value="prefs.theme"
          :items="modeItems"
          :label="t('appearance.mode')"
          @update:model-value="(v) => update({ theme: v })"
        />
      </v-col>
    </v-row>
    <v-radio-group
      :model-value="prefs.appearanceTheme"
      :aria-label="t('appearance.theme')"
      color="primary"
      hide-details
      @update:model-value="pick"
    >
      <h3 class="text-title-medium mb-2">{{ t('appearance.builtIn') }}</h3>
      <div class="theme-options">
        <v-radio
          v-for="option in builtIn"
          :key="option.key"
          :value="option.key"
          class="theme-option"
        >
          <template #label>
            <span
              class="swatches"
              aria-hidden="true"
              :style="{ backgroundColor: option.palette.background }"
            >
              <span
                v-for="color in SWATCHES"
                :key="color"
                class="swatch"
                :style="{ backgroundColor: option.palette[color] }"
              />
            </span>
            {{ option.name }}
          </template>
        </v-radio>
      </div>
    </v-radio-group>

    <div class="d-flex align-center flex-wrap ga-2 mt-8 mb-1">
      <h2 class="text-title-large me-auto">{{ t('appearance.adjust') }}</h2>
      <v-btn variant="tonal" :disabled="!adjusted" @click="reset">
        {{ t('appearance.reset') }}
      </v-btn>
    </div>
    <p class="text-body-medium text-medium-emphasis mb-4">{{ t('appearance.adjustHint') }}</p>

    <h3 class="text-title-medium mb-1">
      {{ t('appearance.colors', { mode: t(`theme.${mode}`) }) }}
    </h3>
    <p class="text-body-medium text-medium-emphasis mb-2">{{ t('appearance.colorsHint') }}</p>
    <v-row dense>
      <v-col v-for="color in COLORS" :key="color" cols="12" sm="6" md="4">
        <v-text-field
          type="color"
          :model-value="palette[color]"
          :label="t(`appearance.colorNames.${color}`)"
          :hint="lowContrast(color)"
          :persistent-hint="issues.has(color)"
          :append-inner-icon="issues.has(color) ? mdiAlertCircleOutline : undefined"
          @update:model-value="(v: string) => setColor(color, v)"
        />
      </v-col>
    </v-row>

    <h3 class="text-title-medium mt-4 mb-2">{{ t('appearance.text') }}</h3>
    <v-row>
      <v-col cols="12" sm="6">
        <v-select
          :model-value="tokens.uiFont"
          :items="uiFontItems"
          :label="t('appearance.uiFont')"
          @update:model-value="(v) => adjust({ uiFont: v })"
        />
      </v-col>
      <v-col cols="12" sm="6">
        <v-select
          :model-value="tokens.articleFont"
          :items="articleFontItems"
          :label="t('appearance.articleFont')"
          :hint="t('appearance.articleFontHint')"
          persistent-hint
          @update:model-value="(v) => adjust({ articleFont: v })"
        />
      </v-col>
      <v-col cols="12">
        <v-slider
          :model-value="tokens.fontScale"
          :label="t('appearance.fontScale')"
          :aria-label="t('appearance.fontScale')"
          :min="MIN_FONT_SCALE"
          :max="MAX_FONT_SCALE"
          :step="0.125"
          thumb-label
          @update:model-value="(v: number) => adjust({ fontScale: v })"
        >
          <template #thumb-label="{ modelValue }">
            {{ n(modelValue, { style: 'percent' }) }}
          </template>
        </v-slider>
      </v-col>
    </v-row>

    <h3 class="text-title-medium mb-2">{{ t('appearance.shape') }}</h3>
    <v-row>
      <v-col cols="12" sm="6">
        <v-select
          :model-value="tokens.style"
          :items="styleItems"
          :label="t('appearance.style')"
          @update:model-value="(v) => adjust({ style: v })"
        />
      </v-col>
      <v-col cols="12" sm="6">
        <v-select
          :model-value="tokens.radius"
          :items="radiusItems"
          :label="t('appearance.radius')"
          @update:model-value="(v) => adjust({ radius: v })"
        />
      </v-col>
      <v-col cols="12" sm="6">
        <v-select
          :model-value="tokens.density"
          :items="densityItems"
          :label="t('appearance.density')"
          @update:model-value="(v) => adjust({ density: v })"
        />
      </v-col>
      <v-col cols="12" sm="6">
        <v-select
          :model-value="tokens.border"
          :items="borderItems"
          :label="t('appearance.border')"
          @update:model-value="(v) => adjust({ border: v })"
        />
      </v-col>
      <v-col cols="12" sm="6">
        <v-select
          :model-value="tokens.elevation"
          :items="elevationItems"
          :label="t('appearance.elevation')"
          @update:model-value="(v) => adjust({ elevation: v })"
        />
      </v-col>
    </v-row>
    <v-switch
      v-for="effect in ['texture', 'animation'] as const"
      :key="effect"
      :model-value="tokens.effects[effect]"
      :label="t(`appearance.effects.${effect}`)"
      color="primary"
      density="compact"
      hide-details
      @update:model-value="(v) => adjust({ effects: { [effect]: Boolean(v) } })"
    />
  </section>
</template>

<style scoped>
.theme-options {
  display: flex;
  flex-wrap: wrap;
  gap: 0.75rem;
}
.theme-option {
  flex: 0 0 auto;
  padding: 0.5rem 1rem 0.5rem 0.25rem;
  border: thin solid rgba(var(--v-border-color), var(--v-border-opacity));
  border-radius: 8px;
}
.swatches {
  display: inline-flex;
  gap: 0.25rem;
  margin-inline-end: 0.75rem;
  padding: 0.375rem;
  border: thin solid rgba(var(--v-border-color), var(--v-border-opacity));
  border-radius: 4px;
}
.swatch {
  width: 1rem;
  height: 1rem;
  border-radius: 50%;
}
</style>
