<script setup lang="ts">
import type { PartialThemeTokens, Prefs, Theme, ThemePalette } from '@newses/shared';
import {
  BUILTIN_THEME_KEYS,
  BUILTIN_THEMES,
  FONT_KEYS,
  MAX_FONT_SCALE,
  MAX_THEME_NAME_LENGTH,
  MIN_FONT_SCALE,
  THEME_BORDERS,
  THEME_DENSITIES,
  THEME_ELEVATIONS,
  THEME_RADII,
  THEME_STYLES,
} from '@newses/shared/client';
import { mdiAlertCircleOutline, mdiDotsVertical, mdiUpload } from '@mdi/js';
import { computed, onBeforeUnmount, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { useTheme } from 'vuetify';
import { ApiError } from '../../api.ts';
import { adjustmentsPreview } from '../../composables/useAppearance.ts';
import { usePrefs } from '../../composables/usePrefs.ts';
import { useReturnFocus } from '../../composables/useReturnFocus.ts';
import { useSession } from '../../composables/useSession.ts';
import { useThemeActions, useThemes } from '../../composables/useThemes.ts';
import {
  contrastIssues,
  type CustomTheme,
  mergeAdjustments,
  mergeTokens,
  themeTokens,
} from '../../lib/appearance.ts';
import { readThemeFile, themeFile, themeFileName, uniqueName } from '../../lib/theme-files.ts';
import { bridge } from '../../platform/index.ts';
import { useUiStore } from '../../stores/ui.ts';

const { t, n } = useI18n();
const ui = useUiStore();
const vuetifyTheme = useTheme();
const { prefs, update } = usePrefs();
const themes = useThemes();
const actions = useThemeActions();
const { session } = useSession();
const isAdmin = computed(() => session.value?.user.role === 'admin');

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

const custom = (id: number) => themes.data.value?.find((theme) => theme.id === id);
/** The custom theme in use; undefined for a built-in one. */
const current = computed(() => {
  const reference = prefs.value.appearanceTheme;
  return typeof reference === 'number' ? custom(reference) : undefined;
});
/** The theme in use as a base and overrides, which the adjustments apply to. */
const source = computed<CustomTheme>(() => {
  const reference = prefs.value.appearanceTheme;
  if (typeof reference === 'string') return { base: reference, tokens: {} };
  return current.value ?? { base: 'original', tokens: {} };
});
const currentName = computed(() =>
  typeof prefs.value.appearanceTheme === 'string'
    ? t(`appearance.themes.${prefs.value.appearanceTheme}`)
    : (current.value?.name ?? t('appearance.themes.original')),
);

/** The theme as shown, adjustments included. */
const tokens = computed(() =>
  themeTokens(
    { appearanceTheme: prefs.value.appearanceTheme, themeAdjustments: adjustments.value },
    custom,
  ),
);
const palette = computed(() => tokens.value.palette[mode.value]);
const issues = computed(
  () => new Map(contrastIssues(palette.value, mode.value).map((i) => [i.color, i])),
);

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

interface ThemeOption {
  value: Prefs['appearanceTheme'];
  name: string;
  palette: ThemePalette;
  /** A custom theme's; built-in themes have none. */
  theme?: Theme;
}

const customOption = (theme: Theme): ThemeOption => ({
  value: theme.id,
  name: theme.name,
  palette: mergeTokens(BUILTIN_THEMES[theme.base], theme.tokens).palette[mode.value],
  theme,
});
const mine = computed(() => (themes.data.value ?? []).filter((theme) => theme.mine));
const groups = computed(() =>
  [
    {
      title: t('appearance.builtIn'),
      options: BUILTIN_THEME_KEYS.map((key): ThemeOption => ({
        value: key,
        name: t(`appearance.themes.${key}`),
        palette: BUILTIN_THEMES[key].palette[mode.value],
      })),
    },
    { title: t('appearance.mine'), options: mine.value.map(customOption) },
    {
      title: t('appearance.shared'),
      options: (themes.data.value ?? []).filter((theme) => !theme.mine).map(customOption),
    },
  ].filter((group) => group.options.length > 0),
);
const ownNames = () => mine.value.map((theme) => theme.name);

const busy = ref(false);
async function run(work: () => Promise<unknown>): Promise<boolean> {
  busy.value = true;
  try {
    await work();
    return true;
  } catch (error) {
    ui.notify(error instanceof ApiError ? error.message : t('errors.generic'), true);
    return false;
  } finally {
    busy.value = false;
  }
}

/** The name dialog, for a new theme or a rename. */
const naming = ref<{
  title: string;
  name: string;
  save: (name: string) => Promise<unknown>;
} | null>(null);
const restoreFocus = useReturnFocus(() => naming.value !== null);
async function saveName() {
  const value = naming.value;
  const name = value?.name.trim();
  if (!value || !name) return;
  if (await run(() => value.save(name))) naming.value = null;
}

/** Keeps the adjusted theme as a new theme of the user's own, and switches to it. */
function saveAsNew() {
  naming.value = {
    title: t('appearance.saveAsNew'),
    name: uniqueName(currentName.value, ownNames()),
    save: async (name) => {
      const { base, tokens: overrides } = source.value;
      const theme = await actions.create({
        name,
        base,
        tokens: mergeAdjustments(overrides, adjustments.value),
      });
      discardAdjustments();
      update({ appearanceTheme: theme.id, themeAdjustments: {} });
      ui.notify(t('appearance.saved', { name }));
    },
  };
}

/** Writes the adjustments into the user's own theme in use. */
async function updateTheme() {
  const theme = current.value;
  if (!theme?.mine) return;
  const saved = await run(() =>
    actions.update(theme.id, { tokens: mergeAdjustments(theme.tokens, adjustments.value) }),
  );
  if (!saved) return;
  discardAdjustments();
  update({ themeAdjustments: {} });
  ui.notify(t('appearance.saved', { name: theme.name }));
}

function rename(theme: Theme) {
  naming.value = {
    title: t('appearance.rename'),
    name: theme.name,
    save: (name) => actions.update(theme.id, { name }),
  };
}

async function duplicate(theme: Theme) {
  const name = uniqueName(t('appearance.copyName', { name: theme.name }), ownNames());
  if (await run(() => actions.create({ name, base: theme.base, tokens: theme.tokens })))
    ui.notify(t('appearance.saved', { name }));
}

/** Publishing shares the theme with everyone on the server; below WCAG AA it asks first. */
async function publish(theme: Theme) {
  const tokens = mergeTokens(BUILTIN_THEMES[theme.base], theme.tokens);
  const lowContrast =
    contrastIssues(tokens.palette.light, 'light').length +
      contrastIssues(tokens.palette.dark, 'dark').length >
    0;
  if (
    lowContrast &&
    !(await ui.confirm(
      t('appearance.publishTitle'),
      t('appearance.publishLowContrast', { name: theme.name }),
      t('appearance.publish'),
    ))
  )
    return;
  if (await run(() => actions.update(theme.id, { shared: true })))
    ui.notify(t('appearance.published', { name: theme.name }));
}

async function unpublishOwn(theme: Theme) {
  if (await run(() => actions.update(theme.id, { shared: false })))
    ui.notify(t('appearance.unpublished', { name: theme.name }));
}

/** An admin withdraws someone else's theme; its users go back to Original. */
async function unpublishShared(theme: Theme) {
  if (
    !(await ui.confirm(
      t('appearance.unpublishTitle'),
      t('appearance.unpublishText', { name: theme.name, author: theme.owner.login }),
      t('appearance.unpublish'),
    ))
  )
    return;
  if (await run(() => actions.unpublish(theme.id)))
    ui.notify(t('appearance.unpublished', { name: theme.name }));
}

/** Deleting the theme in use returns to Original. */
async function remove(theme: Theme) {
  if (
    !(await ui.confirm(
      t('appearance.deleteTitle'),
      t('appearance.deleteText', { name: theme.name }),
      t('common.delete'),
    ))
  )
    return;
  const deleted = await run(() => actions.remove(theme.id));
  if (deleted && prefs.value.appearanceTheme === theme.id) {
    discardAdjustments();
    update({ appearanceTheme: 'original', themeAdjustments: {} });
  }
}

/** Through the bridge, so the apps save the file where the user chooses. */
async function exportTheme(theme: Theme) {
  await run(() =>
    bridge.saveFile({
      name: themeFileName(theme.name),
      type: 'application/json',
      data: themeFile(theme),
    }),
  );
}

/** The server validates the theme; a name already used gets a number. */
const fileInput = ref<HTMLInputElement | null>(null);
async function importTheme(event: Event) {
  const file = (event.target as HTMLInputElement).files?.[0];
  if (fileInput.value) fileInput.value.value = '';
  if (!file) return;
  const theme = readThemeFile(await file.text());
  if (!theme) {
    ui.notify(t('appearance.importInvalid'), true);
    return;
  }
  const name = uniqueName(theme.name, ownNames());
  try {
    await actions.create({ ...theme, name });
    ui.notify(t('appearance.imported', { name }));
  } catch (error) {
    const invalid = error instanceof ApiError && error.status === 400;
    ui.notify(invalid ? t('appearance.importInvalid') : t('errors.generic'), true);
  }
}

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
      <template v-for="group in groups" :key="group.title">
        <h3 class="text-title-medium mb-2">{{ group.title }}</h3>
        <div class="theme-options mb-4">
          <div v-for="option in group.options" :key="option.value" class="theme-option">
            <v-radio :value="option.value">
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
                <span>
                  {{ option.name }}
                  <span
                    v-if="option.theme && !option.theme.mine"
                    class="d-block text-body-small text-medium-emphasis"
                  >
                    {{ t('appearance.by', { author: option.theme.owner.login }) }}
                  </span>
                  <span
                    v-else-if="option.theme?.shared"
                    class="d-block text-body-small text-medium-emphasis"
                  >
                    {{ t('appearance.isPublished') }}
                  </span>
                </span>
              </template>
            </v-radio>
            <v-menu v-if="option.theme">
              <template #activator="{ props: menu }">
                <v-btn
                  v-bind="menu"
                  :icon="mdiDotsVertical"
                  size="small"
                  :aria-label="t('appearance.themeActions', { name: option.name })"
                />
              </template>
              <v-list density="compact" role="menu">
                <v-list-item
                  v-if="option.theme.mine"
                  role="menuitem"
                  :title="t('appearance.rename')"
                  @click="rename(option.theme)"
                />
                <v-list-item
                  role="menuitem"
                  :title="t('appearance.duplicate')"
                  @click="duplicate(option.theme)"
                />
                <v-list-item
                  role="menuitem"
                  :title="t('appearance.export')"
                  @click="exportTheme(option.theme)"
                />
                <template v-if="option.theme.mine">
                  <v-list-item
                    v-if="option.theme.shared"
                    role="menuitem"
                    :title="t('appearance.unpublish')"
                    @click="unpublishOwn(option.theme)"
                  />
                  <v-list-item
                    v-else
                    role="menuitem"
                    :title="t('appearance.publish')"
                    @click="publish(option.theme)"
                  />
                </template>
                <v-list-item
                  v-else-if="isAdmin"
                  role="menuitem"
                  :title="t('appearance.unpublish')"
                  @click="unpublishShared(option.theme)"
                />
                <v-list-item
                  v-if="option.theme.mine"
                  role="menuitem"
                  :title="t('common.delete')"
                  @click="remove(option.theme)"
                />
              </v-list>
            </v-menu>
          </div>
        </div>
      </template>
    </v-radio-group>
    <v-btn variant="tonal" :prepend-icon="mdiUpload" @click="fileInput?.click()">
      {{ t('appearance.import') }}
    </v-btn>
    <input
      ref="fileInput"
      type="file"
      accept=".json,application/json"
      hidden
      @change="importTheme"
    />

    <div class="d-flex align-center flex-wrap ga-2 mt-8 mb-1">
      <h2 class="text-title-large me-auto">{{ t('appearance.adjust') }}</h2>
      <template v-if="adjusted">
        <v-btn v-if="current?.mine" variant="tonal" :loading="busy" @click="updateTheme">
          {{ t('appearance.updateTheme') }}
        </v-btn>
        <v-btn color="primary" variant="flat" @click="saveAsNew">
          {{ t('appearance.saveAsNew') }}
        </v-btn>
      </template>
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

    <v-dialog
      :model-value="naming !== null"
      max-width="440"
      @update:model-value="(v) => !v && (naming = null)"
      @after-leave="restoreFocus"
    >
      <v-card v-if="naming" :title="naming.title">
        <v-form @submit.prevent="saveName">
          <v-card-text>
            <v-text-field
              v-model="naming.name"
              :label="t('appearance.name')"
              :maxlength="MAX_THEME_NAME_LENGTH"
              counter
              autofocus
            />
          </v-card-text>
          <v-card-actions>
            <v-spacer />
            <v-btn @click="naming = null">{{ t('common.cancel') }}</v-btn>
            <v-btn
              type="submit"
              color="primary"
              variant="flat"
              :loading="busy"
              :disabled="!naming.name.trim()"
            >
              {{ t('common.save') }}
            </v-btn>
          </v-card-actions>
        </v-form>
      </v-card>
    </v-dialog>
  </section>
</template>

<style scoped>
.theme-options {
  display: flex;
  flex-wrap: wrap;
  gap: 0.75rem;
}
.theme-option {
  display: flex;
  align-items: center;
  flex: 0 0 auto;
  padding: 0.5rem 0.5rem 0.5rem 0.25rem;
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
