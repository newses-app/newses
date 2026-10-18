<script setup lang="ts">
import type { Entry } from '@newses/shared';
import { mdiBookmarkOutline, mdiLinkOff, mdiOpenInNew, mdiPlus, mdiRefresh } from '@mdi/js';
import { useQuery, useQueryClient } from '@tanstack/vue-query';
import { computed, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { api, ApiError } from '../../api.ts';
import { SHARES_KEY, useEntryActions } from '../../composables/useEntries.ts';
import { bookmarklets } from '../../lib/intents.ts';
import { publishedFeedUrl, shareUrl } from '../../lib/sharing.ts';
import { serverOrigin } from '../../platform/index.ts';
import { useUiStore } from '../../stores/ui.ts';
import CopyField from '../sharing/CopyField.vue';

const PUBLISHED_FEED_KEY = ['published-feed'] as const;

const { t } = useI18n();
const ui = useUiStore();
const queryClient = useQueryClient();
const actions = useEntryActions();
const feed = useQuery({ queryKey: PUBLISHED_FEED_KEY, queryFn: () => api.publishedFeed.get() });
const shares = useQuery({ queryKey: SHARES_KEY, queryFn: () => api.shares() });
const feedUrl = computed(() => (feed.data.value ? publishedFeedUrl(feed.data.value.key) : ''));
const busy = ref(false);
const marks = computed(() => {
  const code = bookmarklets(serverOrigin());
  return [
    { name: t('sharing.publishBookmarklet'), code: code.publish },
    { name: t('sharing.subscribeBookmarklet'), code: code.subscribe },
  ];
});

async function run(work: () => Promise<unknown>, done?: string) {
  busy.value = true;
  try {
    await work();
    if (done) ui.notify(done);
  } catch (error) {
    ui.notify(error instanceof ApiError ? error.message : t('errors.generic'), true);
  } finally {
    busy.value = false;
  }
}

async function regenerate() {
  const confirmed = await ui.confirm(
    t('sharing.regenerate'),
    t('sharing.regenerateConfirm'),
    t('sharing.regenerate'),
  );
  if (confirmed)
    await run(async () => {
      queryClient.setQueryData(PUBLISHED_FEED_KEY, await api.publishedFeed.regenerate());
    }, t('sharing.regenerated'));
}

const revoke = (entry: Entry) => run(() => actions.unshare(entry), t('sharing.revoked'));
</script>

<template>
  <section class="mb-8">
    <h2 class="text-title-large mb-2">{{ t('sharing.publishedFeed') }}</h2>
    <p class="text-body-medium mb-4">{{ t('sharing.publishedFeedHint') }}</p>
    <v-skeleton-loader v-if="!feed.data.value" type="text" />
    <CopyField v-else :value="feedUrl" :label="t('sharing.feedUrl')" />
    <v-btn
      class="mt-4"
      variant="tonal"
      :prepend-icon="mdiRefresh"
      :disabled="busy"
      @click="regenerate"
    >
      {{ t('sharing.regenerate') }}
    </v-btn>
  </section>
  <section class="mb-8">
    <h2 class="text-title-large mb-2">{{ t('sharing.publishPage') }}</h2>
    <p class="text-body-medium mb-4">{{ t('sharing.publishPageHint') }}</p>
    <v-btn variant="tonal" :prepend-icon="mdiPlus" @click="ui.publishOpen = true">
      {{ t('sharing.publishPage') }}
    </v-btn>
  </section>
  <section class="mb-8">
    <h2 class="text-title-large mb-2">{{ t('sharing.bookmarklets') }}</h2>
    <p class="text-body-medium mb-4">{{ t('sharing.bookmarkletsHint') }}</p>
    <div v-for="mark in marks" :key="mark.name" class="mb-4">
      <!-- Dragged to the bookmarks bar; the app's CSP would block running it here. -->
      <v-btn
        class="mb-2"
        variant="outlined"
        :prepend-icon="mdiBookmarkOutline"
        :href="mark.code"
        draggable="true"
        @click.prevent="ui.notify(t('sharing.dragHint'))"
      >
        {{ mark.name }}
      </v-btn>
      <CopyField :value="mark.code" :label="t('sharing.bookmarkletCode', { name: mark.name })" />
    </div>
  </section>
  <section>
    <h2 class="text-title-large mb-2">{{ t('sharing.sharedArticles') }}</h2>
    <p v-if="shares.data.value?.length === 0" class="text-body-medium text-medium-emphasis">
      {{ t('sharing.noShares') }}
    </p>
    <v-list v-else density="compact">
      <v-list-item
        v-for="entry in shares.data.value"
        :key="entry.id"
        :title="entry.title ?? t('entries.untitled')"
        :subtitle="entry.feedTitle ?? ''"
      >
        <template #append>
          <v-btn
            :icon="mdiOpenInNew"
            size="small"
            :href="shareUrl(entry.shareId ?? '')"
            target="_blank"
            rel="noopener noreferrer"
            :aria-label="t('sharing.openNamed', { title: entry.title ?? t('entries.untitled') })"
          />
          <v-btn
            :icon="mdiLinkOff"
            size="small"
            :disabled="busy"
            :aria-label="t('sharing.revokeNamed', { title: entry.title ?? t('entries.untitled') })"
            @click="revoke(entry)"
          />
        </template>
      </v-list-item>
    </v-list>
  </section>
</template>
