<script setup lang="ts">
import type { PluginTestResult } from '@newses/shared';
import { mdiSendCheck } from '@mdi/js';
import { computed, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { useErrorText } from '../../composables/useErrorText.ts';
import { useOnlineOnly } from '../../composables/useOnlineOnly.ts';
import { useUiStore } from '../../stores/ui.ts';

// "Send test": runs the plugin's test with the saved settings and shows how it went; with
// `digest`, a passing test (or none) is followed by a test digest emailed to the user.
const props = defineProps<{
  run?: (() => Promise<PluginTestResult>) | undefined;
  digest?: (() => Promise<void>) | undefined;
  /** For a plugin's action: its button's label and hint, in place of Send test's. */
  label?: string | undefined;
  hint?: string | undefined;
}>();

const { t } = useI18n();
const errorText = useErrorText();
const ui = useUiStore();
const { online, whenOnline } = useOnlineOnly();

const testing = ref(false);
const result = ref<PluginTestResult | null>(null);
const digestQueued = ref(false);

const send = whenOnline(async () => {
  testing.value = true;
  result.value = null;
  digestQueued.value = false;
  try {
    const tested = props.run ? await props.run() : null;
    result.value = tested;
    if (props.digest && (tested?.ok ?? true)) {
      await props.digest();
      digestQueued.value = true;
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
  const passed = tested?.message ? t('plugins.testPassed', { message: tested.message }) : null;
  if (digestQueued.value)
    return [passed, t('email.digest.testQueued')].filter((line) => line !== null).join('\n');
  if (!tested) return null;
  return passed ?? t('plugins.testPassedQuietly');
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
        {{ label ?? t('plugins.sendTest') }}
      </v-btn>
      <span class="text-body-small text-medium-emphasis">
        {{ hint ?? t(digest ? 'plugins.testDigestHint' : 'plugins.testHint') }}
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
  </div>
</template>

<style scoped>
.test-outcome {
  white-space: pre-line;
}
</style>
