<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { useRoute, useRouter } from 'vue-router';
import { ApiError } from '../api.ts';
import { useSession } from '../composables/useSession.ts';

const { t } = useI18n();
const route = useRoute();
const router = useRouter();
const { login } = useSession();

const name = ref('');
const password = ref('');
const busy = ref(false);
const error = ref<string | null>(null);
// Vuetify's autofocus waits for an IntersectionObserver callback, which can land after typing has
// started and pull focus back to this field; focusing on mount happens before any input.
const nameField = ref<{ focus: () => void } | null>(null);
onMounted(() => nameField.value?.focus());

async function submit() {
  busy.value = true;
  error.value = null;
  try {
    await login(name.value.trim(), password.value);
    const redirect = typeof route.query.redirect === 'string' ? route.query.redirect : '/all';
    // Only same-app paths, never another origin.
    await router.replace(
      redirect.startsWith('/') && !redirect.startsWith('//') ? redirect : '/all',
    );
  } catch (err) {
    if (err instanceof ApiError && err.status === 429)
      error.value = t('login.throttled', { seconds: err.retryAfterSeconds ?? 60 });
    else if (err instanceof ApiError && err.status === 401) error.value = t('login.invalid');
    else error.value = t('errors.generic');
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <v-main>
    <v-container class="fill-height d-flex align-center justify-center">
      <v-card width="380" class="pa-2" elevation="2">
        <v-card-item>
          <div class="d-flex align-center ga-3">
            <img src="/favicon.svg" alt="" width="40" height="40" />
            <v-card-title class="pa-0">{{ t('app.name') }}</v-card-title>
          </div>
        </v-card-item>
        <v-form @submit.prevent="submit">
          <v-card-text>
            <v-text-field
              ref="nameField"
              v-model="name"
              :label="t('login.name')"
              autocomplete="username"
              required
            />
            <v-text-field
              v-model="password"
              :label="t('login.password')"
              type="password"
              autocomplete="current-password"
              required
            />
            <v-alert v-if="error" type="error" variant="tonal" density="compact">{{
              error
            }}</v-alert>
          </v-card-text>
          <v-card-actions>
            <v-btn
              type="submit"
              color="primary"
              variant="flat"
              block
              size="large"
              :loading="busy"
              :disabled="!name || !password"
            >
              {{ t('login.submit') }}
            </v-btn>
          </v-card-actions>
        </v-form>
      </v-card>
    </v-container>
  </v-main>
</template>
