<script setup lang="ts">
import type { FeedCandidate } from '@newses/shared';
import { ApiError } from '@newses/shared/client';
import { useQuery } from '@tanstack/vue-query';
import { computed, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { useRouter } from 'vue-router';
import { api } from '../../api.ts';
import { useErrorText } from '../../composables/useErrorText.ts';
import { useResourceEdits } from '../../composables/useResourceEdits.ts';
import { temporaryId } from '../../lib/offline-resources.ts';
import { useCategories, useFeedsRefresh } from '../../composables/useFeeds.ts';
import { useOnlineOnly } from '../../composables/useOnlineOnly.ts';
import { useReturnFocus } from '../../composables/useReturnFocus.ts';
import { supportsFeedLogins } from '../../lib/server-url.ts';
import { subscriptionKey } from '../../lib/streams.ts';
import { useUiStore } from '../../stores/ui.ts';
import FeedLoginFields from '../feeds/FeedLoginFields.vue';

const ui = useUiStore();
const router = useRouter();
const { t } = useI18n();
const errorText = useErrorText();
const categories = useCategories();
const refreshFeeds = useFeedsRefresh();

const url = ref('');
const categoryId = ref<number | null>(null);
const candidates = ref<FeedCandidate[]>([]);
const chosen = ref<string | null>(null);
const needsLogin = ref(false);
const login = ref('');
const password = ref('');
const busy = ref(false);
const error = ref<string | null>(null);
const restoreFocus = useReturnFocus(() => ui.subscribeOpen);

/** Servers before API 1.12 fetch no feeds with a login. */
const serverInfo = useQuery({
  queryKey: ['server-info'],
  queryFn: () => api.serverInfo(),
  staleTime: Infinity,
});
const loginsSupported = computed(() =>
  serverInfo.data.value ? supportsFeedLogins(serverInfo.data.value) : false,
);
const { online } = useOnlineOnly();

// Opening starts afresh; a URL shared to the app fills in the address, also while open.
watch(
  () => [ui.subscribeOpen, ui.subscribeUrl] as const,
  ([open, shared], previous) => {
    if (!open || (previous?.[0] && !shared)) return;
    url.value = shared ?? '';
    ui.subscribeUrl = null;
    candidates.value = [];
    chosen.value = null;
    needsLogin.value = false;
    login.value = '';
    password.value = '';
    error.value = null;
  },
  { immediate: true },
);

const { edit } = useResourceEdits();

async function submit() {
  const target = candidates.value.length > 0 ? chosen.value : url.value.trim();
  if (!target) return;
  const withLogin = loginsSupported.value && needsLogin.value;
  // A password is never kept on the device to be sent later.
  if (withLogin && !online.value) {
    error.value = t('offline.needsConnection');
    return;
  }
  busy.value = true;
  error.value = null;
  try {
    const body = { url: target, categoryId: categoryId.value };
    const saved = withLogin
      ? {
          sent: true as const,
          value: await api.subscriptions.subscribe({
            ...body,
            credentials: { login: login.value.trim(), password: password.value },
          }),
        }
      : await edit({ kind: 'subscription.create', id: temporaryId(), body }, () =>
          api.subscriptions.subscribe(body),
        );
    // Without a connection the feed shows as waiting, and is subscribed once the server answers.
    if (!saved.sent) {
      ui.subscribeOpen = false;
      ui.notify(t('offline.subscribeKept', { url: target }));
      return;
    }
    const result = saved.value;
    if (result.status === 'choose') {
      candidates.value = result.candidates;
      chosen.value = result.candidates[0]?.url ?? null;
      return;
    }
    await refreshFeeds();
    ui.subscribeOpen = false;
    ui.notify(t('subscribe.done', { feed: result.subscription.title }));
    await router.push(`/${subscriptionKey(result.subscription.id)}`);
  } catch (err) {
    error.value = errorText(err);
    // The feed asked for a login: offer the fields for one.
    if (loginsSupported.value && err instanceof ApiError && err.reason === 'fetch_login_required')
      needsLogin.value = true;
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <v-dialog v-model="ui.subscribeOpen" max-width="520" @after-leave="restoreFocus">
    <v-card :title="t('subscribe.title')">
      <v-form @submit.prevent="submit">
        <v-card-text>
          <v-text-field
            v-model="url"
            :label="t('subscribe.url')"
            dir="ltr"
            :hint="t('subscribe.urlHint')"
            persistent-hint
            autofocus
            type="url"
            inputmode="url"
            :disabled="candidates.length > 0"
          />
          <v-select
            v-model="categoryId"
            class="mt-4"
            :label="t('feeds.category')"
            :items="[
              { title: t('tree.uncategorised'), value: null },
              ...(categories.data.value ?? []).map((c) => ({ title: c.title, value: c.id })),
            ]"
          />
          <template v-if="loginsSupported">
            <v-checkbox
              v-model="needsLogin"
              :label="t('feedLogin.needsLogin')"
              :hint="t('feedLogin.subscribeHint')"
              persistent-hint
            />
            <FeedLoginFields
              v-if="needsLogin"
              v-model:login="login"
              v-model:password="password"
              class="mt-2"
            />
          </template>
          <template v-if="candidates.length > 0">
            <v-radio-group v-model="chosen" :label="t('subscribe.choose')" hide-details>
              <v-radio
                v-for="candidate in candidates"
                :key="candidate.url"
                :value="candidate.url"
                :label="candidate.title ? `${candidate.title} — ${candidate.url}` : candidate.url"
              />
            </v-radio-group>
          </template>
          <v-alert v-if="error" type="error" variant="tonal" density="compact" class="mt-4">
            {{ error }}
          </v-alert>
        </v-card-text>
        <v-card-actions>
          <v-spacer />
          <v-btn @click="ui.subscribeOpen = false">{{ t('common.cancel') }}</v-btn>
          <v-btn type="submit" color="primary" variant="flat" :loading="busy">
            {{ t('feeds.subscribe') }}
          </v-btn>
        </v-card-actions>
      </v-form>
    </v-card>
  </v-dialog>
</template>
