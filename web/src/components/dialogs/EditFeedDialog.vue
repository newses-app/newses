<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { useRoute, useRouter } from 'vue-router';
import { api, ApiError } from '../../api.ts';
import { useDurations } from '../../composables/useDurations.ts';
import { useCategories, useFeedsRefresh, useSubscriptions } from '../../composables/useFeeds.ts';
import { useOnlineOnly } from '../../composables/useOnlineOnly.ts';
import { useResourceEdits } from '../../composables/useResourceEdits.ts';
import { useReturnFocus } from '../../composables/useReturnFocus.ts';
import { useTreeEditing } from '../../composables/useTreeEditing.ts';
import { formatDateTime } from '../../lib/format.ts';
import { beforeIdAfter, byDisplayOrder, precedingId } from '../../lib/reorder.ts';
import { subscriptionKey } from '../../lib/streams.ts';
import { useUiStore } from '../../stores/ui.ts';

const ui = useUiStore();
const route = useRoute();
const router = useRouter();
const { t, locale } = useI18n();
const subscriptions = useSubscriptions();
const categories = useCategories();
const refreshFeeds = useFeedsRefresh();
const editing = useTreeEditing();

const subscription = computed(() =>
  subscriptions.data.value?.find((s) => s.id === ui.editSubscriptionId),
);
const open = computed({
  get: () => ui.editSubscriptionId !== null,
  set: (value) => {
    if (!value) ui.editSubscriptionId = null;
  },
});
const restoreFocus = useReturnFocus(() => open.value);

const title = ref('');
const categoryId = ref<number | null>(null);
const interval = ref<number | null>(null);
const purgeDays = ref<number | null>(null);
const fullText = ref(false);
const busy = ref(false);
/** The feed this one follows in its category, or null for first: the non-drag way to reorder. */
const after = ref<number | null>(null);

const inCategory = (id: number | null) =>
  (subscriptions.data.value ?? []).filter((s) => s.categoryId === id).sort(byDisplayOrder);
const siblings = computed(() =>
  inCategory(categoryId.value).filter((s) => s.id !== subscription.value?.id),
);
const positionItems = computed(() => [
  { title: t('common.first'), value: null },
  ...siblings.value.map((s) => ({ title: t('common.after', { name: s.title }), value: s.id })),
]);

watch(subscription, (s) => {
  if (!s) return;
  title.value = s.customTitle ?? '';
  categoryId.value = s.categoryId;
  interval.value = s.updateIntervalMinutes;
  purgeDays.value = s.purgeDays;
  fullText.value = s.fullText;
  after.value = precedingId(inCategory(s.categoryId), s.id);
});

/** A feed moved to another category goes last unless a position is chosen. */
function changeCategory(id: number | null) {
  categoryId.value = id;
  after.value = siblings.value.at(-1)?.id ?? null;
}

const { intervalItems, purgeItems } = useDurations();

const { edit } = useResourceEdits();
const { online, whenOnline } = useOnlineOnly();

async function run(work: () => Promise<unknown>, done?: string) {
  busy.value = true;
  try {
    await work();
    await refreshFeeds();
    if (done) ui.notify(done);
  } catch (error) {
    ui.notify(error instanceof ApiError ? error.message : t('errors.generic'), true);
  } finally {
    busy.value = false;
  }
}

function save() {
  const s = subscription.value;
  if (!s) return;
  const moved =
    categoryId.value !== s.categoryId ||
    after.value !== precedingId(inCategory(s.categoryId), s.id);
  const changes = {
    title: title.value.trim() || null,
    updateIntervalMinutes: interval.value,
    purgeDays: purgeDays.value,
    fullText: fullText.value,
  };
  void run(async () => {
    await edit({ kind: 'subscription.update', id: s.id, changes }, () =>
      api.subscriptions.update(s.id, changes),
    );
    if (moved)
      await editing.moveFeed(s.id, categoryId.value, beforeIdAfter(siblings.value, after.value));
    open.value = false;
  });
}

/** Fetching the feed is the server's job. */
const refresh = whenOnline(() => {
  const s = subscription.value;
  if (s) void run(() => api.subscriptions.refresh(s.id), t('feeds.refreshRequested'));
});

async function unsubscribe() {
  const s = subscription.value;
  if (!s) return;
  const confirmed = await ui.confirm(
    t('feeds.unsubscribe'),
    t('feeds.unsubscribeConfirm', { feed: s.title }),
    t('feeds.unsubscribe'),
  );
  if (!confirmed) return;
  await run(async () => {
    await edit({ kind: 'subscription.delete', id: s.id }, () =>
      api.subscriptions.unsubscribe(s.id),
    );
    open.value = false;
    if (route.params.stream === subscriptionKey(s.id)) await router.push('/all');
  });
}
</script>

<template>
  <v-dialog v-model="open" max-width="560" @after-leave="restoreFocus">
    <v-card v-if="subscription" :title="t('feeds.edit')" :subtitle="subscription.url">
      <v-form @submit.prevent="save">
        <v-card-text>
          <v-text-field
            v-model="title"
            :label="t('feeds.title')"
            :placeholder="subscription.title"
          />
          <v-select
            :model-value="categoryId"
            :label="t('feeds.category')"
            :items="[
              { title: t('tree.uncategorised'), value: null },
              ...(categories.data.value ?? []).map((c) => ({ title: c.title, value: c.id })),
            ]"
            @update:model-value="changeCategory"
          />
          <v-select v-model="after" :label="t('feeds.position')" :items="positionItems" />
          <v-select v-model="interval" :label="t('feeds.interval')" :items="intervalItems" />
          <v-select v-model="purgeDays" :label="t('feeds.purge')" :items="purgeItems" />
          <v-checkbox
            v-model="fullText"
            :label="t('feeds.fullText')"
            :hint="t('feeds.fullTextHint')"
            persistent-hint
          />
          <p class="text-body-small text-medium-emphasis">
            <template v-if="subscription.lastFetchedAt">
              {{
                t('feeds.lastFetched', { when: formatDateTime(subscription.lastFetchedAt, locale) })
              }}
            </template>
            <template v-else>{{ t('feeds.neverFetched') }}</template>
          </p>
          <v-alert
            v-if="subscription.lastError"
            :type="subscription.disabled ? 'error' : 'warning'"
            variant="tonal"
            density="compact"
            class="mt-2"
          >
            {{
              subscription.disabled
                ? t('feeds.disabled', { error: subscription.lastError })
                : subscription.lastError
            }}
          </v-alert>
        </v-card-text>
        <v-card-actions class="flex-wrap">
          <v-btn color="error" :disabled="busy" @click="unsubscribe">{{
            t('feeds.unsubscribe')
          }}</v-btn>
          <v-btn :disabled="busy" :aria-disabled="!online" @click="refresh">
            {{ t('feeds.refresh') }}
          </v-btn>
          <v-spacer />
          <v-btn @click="open = false">{{ t('common.cancel') }}</v-btn>
          <v-btn type="submit" color="primary" variant="flat" :loading="busy">{{
            t('common.save')
          }}</v-btn>
        </v-card-actions>
      </v-form>
    </v-card>
  </v-dialog>
</template>
