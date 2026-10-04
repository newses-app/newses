<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { useRoute, useRouter } from 'vue-router';
import { api, ApiError } from '../../api.ts';
import { useDurations } from '../../composables/useDurations.ts';
import { useCategories, useFeedsRefresh, useSubscriptions } from '../../composables/useFeeds.ts';
import { formatDateTime } from '../../lib/format.ts';
import { subscriptionKey } from '../../lib/streams.ts';
import { useUiStore } from '../../stores/ui.ts';

const ui = useUiStore();
const route = useRoute();
const router = useRouter();
const { t, locale } = useI18n();
const subscriptions = useSubscriptions();
const categories = useCategories();
const refreshFeeds = useFeedsRefresh();

const subscription = computed(() =>
  subscriptions.data.value?.find((s) => s.id === ui.editSubscriptionId),
);
const open = computed({
  get: () => ui.editSubscriptionId !== null,
  set: (value) => {
    if (!value) ui.editSubscriptionId = null;
  },
});

const title = ref('');
const categoryId = ref<number | null>(null);
const interval = ref<number | null>(null);
const purgeDays = ref<number | null>(null);
const busy = ref(false);

watch(subscription, (s) => {
  if (!s) return;
  title.value = s.customTitle ?? '';
  categoryId.value = s.categoryId;
  interval.value = s.updateIntervalMinutes;
  purgeDays.value = s.purgeDays;
});

const { intervalItems, purgeItems } = useDurations();

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
  void run(async () => {
    await api.subscriptions.update(s.id, {
      title: title.value.trim() || null,
      categoryId: categoryId.value,
      updateIntervalMinutes: interval.value,
      purgeDays: purgeDays.value,
    });
    open.value = false;
  });
}

function refresh() {
  const s = subscription.value;
  if (s) void run(() => api.subscriptions.refresh(s.id), t('feeds.refreshRequested'));
}

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
    await api.subscriptions.unsubscribe(s.id);
    open.value = false;
    if (route.params.stream === subscriptionKey(s.id)) await router.push('/all');
  });
}
</script>

<template>
  <v-dialog v-model="open" max-width="560">
    <v-card v-if="subscription" :title="t('feeds.edit')" :subtitle="subscription.url">
      <v-form @submit.prevent="save">
        <v-card-text>
          <v-text-field
            v-model="title"
            :label="t('feeds.title')"
            :placeholder="subscription.title"
          />
          <v-select
            v-model="categoryId"
            :label="t('feeds.category')"
            :items="[
              { title: t('tree.uncategorised'), value: null },
              ...(categories.data.value ?? []).map((c) => ({ title: c.title, value: c.id })),
            ]"
          />
          <v-select v-model="interval" :label="t('feeds.interval')" :items="intervalItems" />
          <v-select v-model="purgeDays" :label="t('feeds.purge')" :items="purgeItems" />
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
          <v-btn :disabled="busy" @click="refresh">{{ t('feeds.refresh') }}</v-btn>
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
