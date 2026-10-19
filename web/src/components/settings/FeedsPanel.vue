<script setup lang="ts">
import type { Category } from '@newses/shared';
import {
  mdiAlertCircleOutline,
  mdiCancel,
  mdiDelete,
  mdiDownload,
  mdiFolderPlusOutline,
  mdiPencil,
  mdiPlus,
  mdiRefresh,
  mdiUpload,
} from '@mdi/js';
import { computed, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { api, ApiError } from '../../api.ts';
import FeedErrorNote from '../feeds/FeedErrorNote.vue';
import { useCategories, useFeedsRefresh, useSubscriptions } from '../../composables/useFeeds.ts';
import { useOnlineOnly } from '../../composables/useOnlineOnly.ts';
import { useResourceEdits } from '../../composables/useResourceEdits.ts';
import { useReturnFocus } from '../../composables/useReturnFocus.ts';
import { useTreeEditing } from '../../composables/useTreeEditing.ts';
import { formatRelative } from '../../lib/format.ts';
import { temporaryId } from '../../lib/offline-resources.ts';
import { beforeIdAfter, byDisplayOrder, precedingId } from '../../lib/reorder.ts';
import { bridge } from '../../platform/index.ts';
import { useUiStore } from '../../stores/ui.ts';

const { t, locale } = useI18n();
const ui = useUiStore();

const exporting = ref(false);
/** Through the bridge, so the apps save the file where the user chooses. */
async function exportOpml() {
  exporting.value = true;
  try {
    const data = await api.opml.export();
    await bridge.saveFile({ name: 'subscriptions.opml', type: 'text/x-opml', data });
  } catch (error) {
    ui.notify(error instanceof ApiError ? error.message : t('errors.generic'), true);
  } finally {
    exporting.value = false;
  }
}
const subscriptions = useSubscriptions();
const categories = useCategories();
const refreshFeeds = useFeedsRefresh();
const tree = useTreeEditing();

const errorsOnly = ref(false);
const categoryName = (id: number | null) =>
  id === null
    ? t('tree.uncategorised')
    : (categories.data.value?.find((c) => c.id === id)?.title ?? '');
const rows = computed(() =>
  [...(subscriptions.data.value ?? [])]
    .filter((s) => !errorsOnly.value || s.errorCount > 0 || s.disabled)
    .sort((a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: 'base' })),
);
const errorCount = computed(
  () => subscriptions.data.value?.filter((s) => s.errorCount > 0 || s.disabled).length ?? 0,
);

const fileInput = ref<HTMLInputElement | null>(null);

async function run(work: () => Promise<unknown>, done?: string) {
  try {
    await work();
    if (done) ui.notify(done);
  } catch (error) {
    ui.notify(error instanceof ApiError ? error.message : t('errors.generic'), true);
  } finally {
    await refreshFeeds();
  }
}

const { online, whenOnline } = useOnlineOnly();
/** OPML import and export are the server's. */
const pickOpml = whenOnline(() => fileInput.value?.click());
const exportOpmlOnline = whenOnline(() => exportOpml());
const { edit } = useResourceEdits();

/** Fetching a feed is the server's job. */
const refreshFeed = whenOnline((id: number) =>
  run(() => api.subscriptions.refresh(id), t('feeds.refreshRequested')),
);

// Category create/edit dialog; `after` is the sibling it follows, or null for first.
const editing = ref<{
  category: Category | null;
  title: string;
  parentId: number | null;
  after: number | null;
} | null>(null);
const restoreFocus = useReturnFocus(() => editing.value !== null);
const childrenOf = (parentId: number | null) =>
  (categories.data.value ?? []).filter((c) => c.parentId === parentId).sort(byDisplayOrder);
const siblings = computed(() =>
  editing.value
    ? childrenOf(editing.value.parentId).filter((c) => c.id !== editing.value?.category?.id)
    : [],
);
const positionItems = computed(() => [
  { title: t('common.first'), value: null },
  ...siblings.value.map((c) => ({ title: t('common.after', { name: c.title }), value: c.id })),
]);
function newCategory() {
  editing.value = { category: null, title: '', parentId: null, after: null };
}
function editCategory(category: Category) {
  const after = precedingId(childrenOf(category.parentId), category.id);
  editing.value = { category, title: category.title, parentId: category.parentId, after };
}
/** A category moved under another parent goes last unless a position is chosen. */
function changeParent(parentId: number | null) {
  if (!editing.value) return;
  editing.value.parentId = parentId;
  editing.value.after = siblings.value.at(-1)?.id ?? null;
}
const parentItems = computed(() => [
  { title: t('settings.topLevel'), value: null },
  ...(categories.data.value ?? [])
    .filter((c) => c.id !== editing.value?.category?.id)
    .map((c) => ({ title: c.title, value: c.id })),
]);
function saveCategory() {
  const value = editing.value;
  if (!value?.title.trim()) return;
  const { category } = value;
  const beforeId = beforeIdAfter(siblings.value, value.after);
  editing.value = null;
  if (!category) {
    const body = { title: value.title.trim(), parentId: value.parentId };
    void run(() =>
      edit({ kind: 'category.create', id: temporaryId(), body }, () => api.categories.create(body)),
    );
    return;
  }
  const moved =
    value.parentId !== category.parentId ||
    value.after !== precedingId(childrenOf(category.parentId), category.id);
  void run(async () => {
    const changes = { title: value.title.trim() };
    await edit({ kind: 'category.update', id: category.id, changes }, () =>
      api.categories.update(category.id, changes),
    );
    if (moved) await tree.moveCategory(category.id, value.parentId, beforeId);
  });
}
async function deleteCategory(category: Category) {
  if (
    await ui.confirm(
      t('settings.deleteCategory'),
      t('settings.deleteCategoryConfirm', { category: category.title }),
      t('common.delete'),
    )
  )
    await run(() =>
      edit({ kind: 'category.delete', id: category.id, parentId: category.parentId }, () =>
        api.categories.delete(category.id),
      ),
    );
}

// OPML import and export.
const importing = ref(false);
async function importOpml(event: Event) {
  const file = (event.target as HTMLInputElement).files?.[0];
  if (!file) return;
  importing.value = true;
  try {
    const result = await api.opml.import(await file.text());
    ui.notify(
      t('settings.opmlImported', {
        subscribed: result.subscribed,
        existing: result.alreadySubscribed,
        invalid: result.invalid.length,
      }),
    );
  } catch (error) {
    ui.notify(error instanceof ApiError ? error.message : t('errors.generic'), true);
  } finally {
    importing.value = false;
    if (fileInput.value) fileInput.value.value = '';
    await refreshFeeds();
  }
}
</script>

<template>
  <section>
    <div class="d-flex flex-wrap ga-2 mb-6">
      <v-btn
        color="primary"
        variant="flat"
        :prepend-icon="mdiPlus"
        @click="ui.subscribeOpen = true"
      >
        {{ t('feeds.subscribe') }}
      </v-btn>
      <v-btn variant="tonal" :prepend-icon="mdiFolderPlusOutline" @click="newCategory">
        {{ t('settings.newCategory') }}
      </v-btn>
      <v-btn
        variant="tonal"
        :prepend-icon="mdiUpload"
        :loading="importing"
        :aria-disabled="!online"
        @click="pickOpml"
      >
        {{ t('settings.importOpml') }}
      </v-btn>
      <input
        ref="fileInput"
        type="file"
        accept=".opml,.xml,text/xml,text/x-opml"
        hidden
        @change="importOpml"
      />
      <v-btn
        variant="tonal"
        :prepend-icon="mdiDownload"
        :loading="exporting"
        :aria-disabled="!online"
        @click="exportOpmlOnline"
      >
        {{ t('settings.exportOpml') }}
      </v-btn>
    </div>

    <h2 class="text-title-large mb-2">{{ t('settings.categories') }}</h2>
    <p
      v-if="categories.data.value?.length === 0"
      class="text-body-medium text-medium-emphasis mb-4"
    >
      {{ t('settings.noCategories') }}
    </p>
    <v-list v-else density="compact" class="mb-6">
      <v-list-item
        v-for="category in categories.data.value"
        :key="category.id"
        :title="category.title"
        :subtitle="
          category.parentId === null
            ? ''
            : t('settings.inCategory', { category: categoryName(category.parentId) })
        "
      >
        <template #append>
          <v-btn
            :icon="mdiPencil"
            size="small"
            :aria-label="t('settings.renameCategoryNamed', { category: category.title })"
            @click="editCategory(category)"
          />
          <v-btn
            :icon="mdiDelete"
            size="small"
            :aria-label="t('settings.deleteCategoryNamed', { category: category.title })"
            @click="deleteCategory(category)"
          />
        </template>
      </v-list-item>
    </v-list>
    <p class="text-body-small text-medium-emphasis mb-6">{{ t('settings.dragHint') }}</p>

    <div class="d-flex align-center flex-wrap mb-2">
      <h2 class="text-title-large me-4">{{ t('settings.subscriptions') }}</h2>
      <v-switch
        v-model="errorsOnly"
        :label="t('settings.errorsOnly', { n: errorCount })"
        color="warning"
        density="compact"
        hide-details
      />
    </div>
    <v-table density="compact">
      <thead>
        <tr>
          <th>{{ t('feeds.title') }}</th>
          <th class="d-none d-sm-table-cell">{{ t('feeds.category') }}</th>
          <th>{{ t('settings.status') }}</th>
          <th>
            <span class="d-sr-only">{{ t('settings.actions') }}</span>
          </th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="s in rows" :key="s.id">
          <td>
            <div class="font-weight-medium">{{ s.title }}</div>
            <div class="text-body-small text-medium-emphasis text-truncate feed-url">
              {{ s.url }}
            </div>
          </td>
          <td class="d-none d-sm-table-cell">{{ categoryName(s.categoryId) }}</td>
          <td class="text-body-small">
            <span v-if="s.disabled" class="text-error">
              <v-icon :icon="mdiCancel" size="small" /> {{ t('settings.disabledStatus') }}
            </span>
            <span v-else-if="s.errorCount > 0" class="text-warning">
              <v-icon :icon="mdiAlertCircleOutline" size="small" />
              {{ t('settings.failing', { n: s.errorCount }, s.errorCount) }}
            </span>
            <span v-else-if="s.paused">{{ t('feeds.pausedStatus') }}</span>
            <span v-else-if="s.lastFetchedAt">{{ formatRelative(s.lastFetchedAt, locale) }}</span>
            <span v-else>{{ t('feeds.neverFetched') }}</span>
            <div v-if="s.hideFromAll" class="text-medium-emphasis">
              {{ t('feeds.hiddenStatus') }}
            </div>
            <div
              v-if="s.lastError"
              class="text-medium-emphasis text-truncate feed-url"
              :title="s.lastError"
            >
              <FeedErrorNote :error="s.lastError" :at="s.lastErrorAt" />
            </div>
          </td>
          <td class="text-no-wrap text-end">
            <v-btn
              :icon="mdiRefresh"
              size="small"
              :aria-label="t('feeds.refreshNamed', { feed: s.title })"
              :aria-disabled="!online"
              @click="refreshFeed(s.id)"
            />
            <v-btn
              :icon="mdiPencil"
              size="small"
              :aria-label="t('feeds.editNamed', { feed: s.title })"
              @click="ui.editSubscriptionId = s.id"
            />
          </td>
        </tr>
        <tr v-if="rows.length === 0">
          <td colspan="4" class="text-medium-emphasis">
            {{ errorsOnly ? t('settings.noErrors') : t('tree.empty') }}
          </td>
        </tr>
      </tbody>
    </v-table>

    <v-dialog
      :model-value="editing !== null"
      max-width="440"
      @update:model-value="(v) => !v && (editing = null)"
      @after-leave="restoreFocus"
    >
      <v-card
        v-if="editing"
        :title="editing.category ? t('settings.renameCategory') : t('settings.newCategory')"
      >
        <v-form @submit.prevent="saveCategory">
          <v-card-text>
            <v-text-field v-model="editing.title" :label="t('settings.categoryName')" autofocus />
            <v-select
              :model-value="editing.parentId"
              :items="parentItems"
              :label="t('settings.parentCategory')"
              @update:model-value="changeParent"
            />
            <v-select
              v-if="editing.category"
              v-model="editing.after"
              :items="positionItems"
              :label="t('feeds.position')"
            />
          </v-card-text>
          <v-card-actions>
            <v-spacer />
            <v-btn @click="editing = null">{{ t('common.cancel') }}</v-btn>
            <v-btn type="submit" color="primary" variant="flat">{{ t('common.save') }}</v-btn>
          </v-card-actions>
        </v-form>
      </v-card>
    </v-dialog>
  </section>
</template>

<style scoped>
.feed-url {
  max-width: 24rem;
}
</style>
