<script setup lang="ts">
import type { PluginEstimateResult } from '@newses/shared';
import { mdiCalculatorVariantOutline } from '@mdi/js';
import { computed, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { useErrorText } from '../../composables/useErrorText.ts';
import { useOnlineOnly } from '../../composables/useOnlineOnly.ts';
import { useUiStore } from '../../stores/ui.ts';

// "Estimate cost": what the plugin expects a test digest for the user now to cost, from its
// `digest.estimate`, sending nothing (API 1.17).
const props = defineProps<{ run: () => Promise<PluginEstimateResult> }>();

const { t, locale } = useI18n();
const errorText = useErrorText();
const ui = useUiStore();
const { online, whenOnline } = useOnlineOnly();

const estimating = ref(false);
const result = ref<PluginEstimateResult | null>(null);

const estimate = whenOnline(async () => {
  estimating.value = true;
  result.value = null;
  try {
    result.value = await props.run();
  } catch (error) {
    ui.notify(errorText(error), true);
  } finally {
    estimating.value = false;
  }
});

const money = computed(
  () =>
    new Intl.NumberFormat(locale.value, {
      style: 'currency',
      currency: 'USD',
      maximumFractionDigits: 2,
    }),
);

/** The digest's size, then the estimate, or how it failed. */
const lines = computed(() => {
  const estimated = result.value;
  if (!estimated) return null;
  const size = t('plugins.estimateArticles', { n: estimated.articles }, estimated.articles);
  const { estimate: value, failure } = estimated;
  if (!value) return { size, cost: t(`plugins.estimateFailure.${failure ?? 'error'}`) };
  const tokens =
    value.tokens === null ? null : new Intl.NumberFormat(locale.value).format(value.tokens);
  const usd =
    value.costUsd === null
      ? null
      : value.costUsd < 0.005
        ? t('plugins.estimateLessThan', { amount: money.value.format(0.01) })
        : money.value.format(value.costUsd);
  const cost =
    tokens !== null && usd !== null
      ? t('plugins.estimateTokensAndCost', { tokens, cost: usd })
      : tokens !== null
        ? t('plugins.estimateTokens', { tokens })
        : usd !== null
          ? t('plugins.estimateCost', { cost: usd })
          : t('plugins.estimateNone');
  return { size, cost, note: value.note };
});
</script>

<template>
  <div class="mb-2">
    <div class="d-flex align-center flex-wrap ga-2">
      <v-btn
        variant="tonal"
        :prepend-icon="mdiCalculatorVariantOutline"
        :loading="estimating"
        :aria-disabled="!online"
        @click="estimate"
      >
        {{ t('plugins.estimate') }}
      </v-btn>
      <span class="text-body-small text-medium-emphasis">{{ t('plugins.estimateHint') }}</span>
    </div>
    <div role="status">
      <v-alert
        v-if="lines"
        :type="result?.estimate ? 'info' : 'error'"
        variant="tonal"
        density="compact"
        class="mt-2"
      >
        <p>{{ lines.size }} {{ lines.cost }}</p>
        <p v-if="lines.note" class="text-medium-emphasis" dir="auto">{{ lines.note }}</p>
      </v-alert>
    </div>
  </div>
</template>
