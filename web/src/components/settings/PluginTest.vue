<script setup lang="ts">
import type { PluginTestResult } from '@newses/shared';
import { mdiSendCheck } from '@mdi/js';
import { computed, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { useErrorText } from '../../composables/useErrorText.ts';
import { useOnlineOnly } from '../../composables/useOnlineOnly.ts';
import { useUiStore } from '../../stores/ui.ts';
import TestDigest from './TestDigest.vue';

// "Send test": runs the plugin's test with the saved settings and shows how it went; with
// `digest`, a passing test (or none) is followed by a test digest's preview, to send or not.
const props = defineProps<{
  run?: (() => Promise<PluginTestResult>) | undefined;
  digest?: boolean;
}>();

const { t } = useI18n();
const errorText = useErrorText();
const ui = useUiStore();
const { online, whenOnline } = useOnlineOnly();

const testing = ref(false);
const result = ref<PluginTestResult | null>(null);
/** The test digest's preview, made again on each test, so it is of the digest now. */
const previewing = ref(false);
const previews = ref(0);

const send = whenOnline(async () => {
  testing.value = true;
  result.value = null;
  previewing.value = false;
  try {
    const tested = props.run ? await props.run() : null;
    result.value = tested;
    if (props.digest && (tested?.ok ?? true)) {
      previews.value++;
      previewing.value = true;
    }
  } catch (error) {
    ui.notify(errorText(error), true);
  } finally {
    testing.value = false;
  }
});

/** What the test said, in the reader's words where the plugin said nothing. */
const outcome = computed(() => {
  const tested = result.value;
  if (tested && !tested.ok) {
    if (tested.message) return t('plugins.testFailed', { message: tested.message });
    return t(`plugins.testFailure.${tested.failure ?? 'error'}`);
  }
  if (!tested) return null;
  return tested.message
    ? t('plugins.testPassed', { message: tested.message })
    : t('plugins.testPassedQuietly');
});
</script>

<template>
  <div class="mb-2">
    <div class="d-flex align-center flex-wrap ga-2">
      <v-btn
        variant="tonal"
        :prepend-icon="mdiSendCheck"
        :loading="testing"
        :aria-disabled="!online"
        @click="send"
      >
        {{ t('plugins.sendTest') }}
      </v-btn>
      <span class="text-body-small text-medium-emphasis">
        {{ t(digest ? 'plugins.testDigestHint' : 'plugins.testHint') }}
      </span>
    </div>
    <div role="status">
      <v-alert
        v-if="outcome"
        :type="result && !result.ok ? 'error' : 'success'"
        variant="tonal"
        density="compact"
        class="mt-2 test-outcome"
        dir="auto"
      >
        {{ outcome }}
      </v-alert>
    </div>
    <TestDigest v-if="previewing" :key="previews" auto />
  </div>
</template>

<style scoped>
.test-outcome {
  white-space: pre-line;
}
</style>
