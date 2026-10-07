<script setup lang="ts">
import { ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { api, ApiError } from '../../api.ts';

const emit = defineEmits<{ changed: [] }>();
const { t } = useI18n();

const current = ref('');
const next = ref('');
const repeat = ref('');
const busy = ref(false);
const error = ref<string | null>(null);

async function changePassword() {
  error.value = null;
  if (next.value.length < 8) {
    error.value = t('account.tooShort');
    return;
  }
  if (next.value !== repeat.value) {
    error.value = t('account.mismatch');
    return;
  }
  busy.value = true;
  try {
    await api.auth.changePassword({ currentPassword: current.value, newPassword: next.value });
    current.value = next.value = repeat.value = '';
    emit('changed');
  } catch (err) {
    const status = err instanceof ApiError ? err.status : null;
    error.value =
      status === 401
        ? t('account.wrongPassword')
        : status === 400
          ? t('account.tooCommon')
          : status === 429
            ? t('account.throttled')
            : t('errors.generic');
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <v-form class="password-form" @submit.prevent="changePassword">
    <v-text-field
      v-model="current"
      type="password"
      :label="t('account.currentPassword')"
      autocomplete="current-password"
    />
    <v-text-field
      v-model="next"
      type="password"
      :label="t('account.newPassword')"
      autocomplete="new-password"
      :hint="t('account.passwordHint')"
    />
    <v-text-field
      v-model="repeat"
      type="password"
      :label="t('account.repeatPassword')"
      autocomplete="new-password"
    />
    <v-alert v-if="error" type="error" variant="tonal" density="compact" class="mb-4">{{
      error
    }}</v-alert>
    <v-btn
      type="submit"
      color="primary"
      variant="flat"
      :loading="busy"
      :disabled="!current || !next"
    >
      {{ t('account.changePassword') }}
    </v-btn>
  </v-form>
</template>

<style scoped>
.password-form {
  max-width: 26rem;
}
</style>
