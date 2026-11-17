<script setup lang="ts">
import type { PluginTestResult } from '@newses/shared';
import { mdiSendCheck } from '@mdi/js';
import { computed, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { useErrorText } from '../../composables/useErrorText.ts';
import { useOnlineOnly } from '../../composables/useOnlineOnly.ts';
import { useUiStore } from '../../stores/ui.ts';

// "Send test": runs the plugin's test with the saved settings and shows how it went.
const props = defineProps<{ run: () => Promise<PluginTestResult> }>();

const { t } = useI18n();
const errorText = useErrorText();
const ui = useUiStore();
const { online, whenOnline } = useOnlineOnly();

const testing = ref(false);
const result = ref<PluginTestResult | null>(null);

const send = whenOnline(async () => {
  testing.value = true;
  result.value = null;
  try {
    result.value = await props.run();
  } catch (error) {
    ui.notify(errorText(error), true);
  } finally {
    testing.value = false;
  }
});

/** What the test said, in the reader's words where the plugin said nothing. */
const outcome = computed(() => {
  const tested = result.value;
  if (!tested) return null;
  if (tested.ok)
    return tested.message
      ? t('plugins.testPassed', { message: tested.message })
      : t('plugins.testPassedQuietly');
  if (tested.message) return t('plugins.testFailed', { message: tested.message });
  return t(`plugins.testFailure.${tested.failure ?? 'error'}`);
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
      <span class="text-body-small text-medium-emphasis">{{ t('plugins.testHint') }}</span>
    </div>
    <div role="status">
      <v-alert
        v-if="outcome"
        :type="result?.ok ? 'success' : 'error'"
        variant="tonal"
        density="compact"
        class="mt-2 test-outcome"
        dir="auto"
      >
        {{ outcome }}
      </v-alert>
    </div>
  </div>
</template>

<style scoped>
.test-outcome {
  white-space: pre-line;
}
</style>
