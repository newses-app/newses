<script setup lang="ts">
import type { DigestTestPreview } from '@newses/shared';
import { mdiEmailFastOutline } from '@mdi/js';
import { computed, onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { api } from '../../api.ts';
import { useErrorText } from '../../composables/useErrorText.ts';
import { useOnlineOnly } from '../../composables/useOnlineOnly.ts';
import { useUiStore } from '../../stores/ui.ts';

// A test digest: a preview of what it would hold now and what each plugin expects it to cost,
// then Send or Cancel (API 1.17). With `auto`, the preview loads at once, without the button.
const props = defineProps<{ auto?: boolean }>();

const { t, locale } = useI18n();
const errorText = useErrorText();
const ui = useUiStore();
const { online, whenOnline } = useOnlineOnly();

const preview = ref<DigestTestPreview | null>(null);
const loading = ref(false);
const sending = ref(false);
const queued = ref(false);
const cancelled = ref(false);

const load = whenOnline(async () => {
  loading.value = true;
  queued.value = false;
  cancelled.value = false;
  try {
    preview.value = await api.account.previewTestDigest();
  } catch (error) {
    ui.notify(errorText(error), true);
  } finally {
    loading.value = false;
  }
});

const send = whenOnline(async () => {
  sending.value = true;
  try {
    await api.account.testDigest();
    preview.value = null;
    queued.value = true;
  } catch (error) {
    ui.notify(errorText(error), true);
  } finally {
    sending.value = false;
  }
});

function cancel() {
  preview.value = null;
  cancelled.value = true;
}

onMounted(() => {
  if (props.auto) void load();
});

const number = computed(() => new Intl.NumberFormat(locale.value));
const money = computed(
  () =>
    new Intl.NumberFormat(locale.value, {
      style: 'currency',
      currency: 'USD',
      maximumFractionDigits: 2,
    }),
);
const cost = (usd: number) =>
  usd < 0.005
    ? t('testDigest.lessThan', { amount: money.value.format(0.01) })
    : money.value.format(usd);

/** Each plugin's line: its estimate, or why it has none. */
const lines = computed(() =>
  (preview.value?.plugins ?? []).map((plugin) => {
    const { estimate, failure, name } = plugin;
    if (!estimate)
      return { id: plugin.pluginId, name, text: t(`testDigest.failure.${failure ?? 'none'}`) };
    const tokens = estimate.tokens === null ? null : number.value.format(estimate.tokens);
    const usd = estimate.costUsd === null ? null : cost(estimate.costUsd);
    const text =
      tokens !== null && usd !== null
        ? t('testDigest.tokensAndCost', { tokens, cost: usd })
        : tokens !== null
          ? t('testDigest.tokens', { tokens })
          : usd !== null
            ? t('testDigest.cost', { cost: usd })
            : t('testDigest.failure.none');
    return { id: plugin.pluginId, name, text, note: estimate.note };
  }),
);
</script>

<template>
  <div>
    <div v-if="!auto && !preview" class="d-flex align-center flex-wrap ga-2">
      <v-btn
        variant="tonal"
        :prepend-icon="mdiEmailFastOutline"
        :loading="loading"
        :aria-disabled="!online"
        @click="load"
      >
        {{ t('email.digest.sendTest') }}
      </v-btn>
      <span class="text-body-small text-medium-emphasis">{{ t('email.digest.testHint') }}</span>
    </div>
    <div role="status">
      <v-progress-linear v-if="auto && loading" indeterminate class="mt-2" />
      <v-alert v-if="preview" type="info" variant="tonal" density="compact" class="mt-2">
        <p>{{ t('testDigest.articles', { n: preview.articles }, preview.articles) }}</p>
        <p v-for="line in lines" :key="line.id">
          <bdi>{{ line.name }}</bdi
          >{{ t('testDigest.separator') }}{{ line.text }}
          <template v-if="line.note">
            <span class="text-medium-emphasis" dir="auto">{{ line.note }}</span>
          </template>
        </p>
        <div class="d-flex flex-wrap ga-2 mt-2">
          <v-btn color="primary" :loading="sending" :aria-disabled="!online" @click="send">
            {{ t('testDigest.send') }}
          </v-btn>
          <v-btn variant="text" @click="cancel">{{ t('testDigest.cancel') }}</v-btn>
        </div>
      </v-alert>
      <v-alert v-if="queued" type="success" variant="tonal" density="compact" class="mt-2">
        {{ t('email.digest.testQueued') }}
      </v-alert>
      <p v-if="cancelled && auto" class="text-body-small text-medium-emphasis mt-2">
        {{ t('testDigest.cancelled') }}
      </p>
    </div>
  </div>
</template>
