<script setup lang="ts">
import { useQuery } from '@tanstack/vue-query';
import { computed, nextTick, onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { useRoute, useRouter } from 'vue-router';
import { api, ApiError } from '../api.ts';
import { useDocumentTitle } from '../composables/useDocumentTitle.ts';
import ProfileMenu from '../components/profiles/ProfileMenu.vue';
import { useSession } from '../composables/useSession.ts';
import { connection, NATIVE } from '../platform/index.ts';
import { reloadAt } from '../platform/profiles.ts';

const { t } = useI18n();
const route = useRoute();
const router = useRouter();
const { login, completeLogin } = useSession();
useDocumentTitle(() => t('login.submit'));

// The apps show which server they sign in to.
const serverInfo = useQuery({
  queryKey: ['server-info'],
  queryFn: () => api.serverInfo(),
  enabled: NATIVE,
  staleTime: Infinity,
});
const serverHost = computed(() =>
  connection.state.serverUrl ? new URL(connection.state.serverUrl).host : '',
);

// A profile signed out by the server signs in again as its user.
const name = ref(connection.activeProfile()?.login ?? '');
const password = ref('');
const passwordField = ref<{ focus: () => void } | null>(null);
/** Set once the password is accepted and an authentication code is needed. */
const challenge = ref<string | null>(null);
const code = ref('');
const codeField = ref<{ focus: () => void } | null>(null);
const busy = ref(false);
const error = ref<string | null>(null);
// Vuetify's autofocus waits for an IntersectionObserver callback, which can land after typing has
// started and pull focus back to this field; focusing on mount happens before any input.
const nameField = ref<{ focus: () => void } | null>(null);
onMounted(() => (name.value ? passwordField : nameField).value?.focus());

function startOver(message: string | null = null) {
  challenge.value = null;
  code.value = '';
  password.value = '';
  error.value = message;
  void nextTick(() => nameField.value?.focus());
}

async function submit() {
  busy.value = true;
  error.value = null;
  const profile = connection.state.active;
  try {
    if (challenge.value) {
      await completeLogin(challenge.value, code.value.trim());
    } else {
      challenge.value = await login(name.value.trim(), password.value);
      if (challenge.value) {
        await nextTick();
        codeField.value?.focus();
        return;
      }
    }
    const redirect = typeof route.query.redirect === 'string' ? route.query.redirect : '/all';
    // Only same-app paths, never another origin.
    const target = redirect.startsWith('/') && !redirect.startsWith('//') ? redirect : '/all';
    // Another user's sign-in moved the app to their profile, which it starts over on.
    if (connection.state.active !== profile) reloadAt(target);
    else await router.replace(target);
  } catch (err) {
    if (err instanceof ApiError && err.status === 429)
      error.value = t('login.throttled', { seconds: err.retryAfterSeconds ?? 60 });
    else if (err instanceof ApiError && err.code === 'password_expired')
      error.value = t('login.passwordExpired');
    else if (err instanceof ApiError && err.status === 401)
      error.value = challenge.value ? t('login.invalidCode') : t('login.invalid');
    else if (challenge.value && err instanceof ApiError && err.status === 400)
      startOver(t('login.expired'));
    else error.value = t('errors.generic');
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <v-main>
    <div class="window-drag-strip" aria-hidden="true" />
    <v-container class="fill-height d-flex align-center justify-center">
      <v-card width="380" class="pa-2" elevation="2">
        <v-card-item>
          <div class="d-flex align-center ga-3">
            <img src="/favicon.svg" alt="" width="40" height="40" />
            <v-card-title tag="h1" class="pa-0">{{ t('app.name') }}</v-card-title>
          </div>
          <div v-if="NATIVE" class="d-flex align-center flex-wrap ga-2 mt-3">
            <span class="text-body-medium text-medium-emphasis">
              {{
                serverInfo.data.value
                  ? t('connect.serverVersion', {
                      host: serverHost,
                      version: serverInfo.data.value.version,
                    })
                  : serverHost
              }}
            </span>
            <ProfileMenu v-if="connection.state.profiles.length > 1">
              <template #activator="{ props: menu }">
                <v-btn variant="text" size="small" v-bind="menu">
                  {{ t('profiles.useAnother') }}
                </v-btn>
              </template>
            </ProfileMenu>
            <v-btn v-else variant="text" size="small" :to="{ name: 'connect' }">
              {{ t('connect.change') }}
            </v-btn>
          </div>
        </v-card-item>
        <v-form @submit.prevent="submit">
          <v-card-text v-if="challenge">
            <p class="text-body-medium mb-4">{{ t('login.codePrompt') }}</p>
            <v-text-field
              ref="codeField"
              v-model="code"
              :label="t('login.code')"
              autocomplete="one-time-code"
              spellcheck="false"
              required
            />
            <v-alert v-if="error" type="error" variant="tonal" density="compact">{{
              error
            }}</v-alert>
          </v-card-text>
          <v-card-text v-else>
            <v-text-field
              ref="nameField"
              v-model="name"
              :label="t('login.name')"
              autocomplete="username"
              required
            />
            <v-text-field
              ref="passwordField"
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
              :disabled="challenge ? !code.trim() : !name || !password"
            >
              {{ challenge ? t('login.verify') : t('login.submit') }}
            </v-btn>
          </v-card-actions>
          <v-card-actions v-if="challenge" class="pt-0">
            <v-btn variant="text" block @click="startOver()">{{ t('login.startOver') }}</v-btn>
          </v-card-actions>
        </v-form>
      </v-card>
    </v-container>
  </v-main>
</template>
