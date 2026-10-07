<script setup lang="ts">
import { mdiLogout } from '@mdi/js';
import { useQuery, useQueryClient } from '@tanstack/vue-query';
import { ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { api, ApiError } from '../../api.ts';
import { useSession } from '../../composables/useSession.ts';
import { formatRelative } from '../../lib/format.ts';
import { useUiStore } from '../../stores/ui.ts';
import TwoFactorSection from './TwoFactorSection.vue';

const { t, locale } = useI18n();
const ui = useUiStore();
const queryClient = useQueryClient();
const { session, logout } = useSession();
const sessions = useQuery({ queryKey: ['sessions'], queryFn: () => api.auth.sessions() });

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
    ui.notify(t('account.passwordChanged'));
    await queryClient.invalidateQueries({ queryKey: ['sessions'] });
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

async function revoke(id: number) {
  try {
    await api.auth.revokeSession(id);
  } catch (err) {
    ui.notify(err instanceof ApiError ? err.message : t('errors.generic'), true);
  }
  await queryClient.invalidateQueries({ queryKey: ['sessions'] });
}
</script>

<template>
  <section>
    <div class="d-flex align-center mb-6">
      <div>
        <h2 class="text-title-large">{{ session?.user.login }}</h2>
        <p class="text-body-medium text-medium-emphasis">
          {{ t(`account.roles.${session?.user.role ?? 'user'}`) }}
        </p>
      </div>
      <v-spacer />
      <v-btn variant="tonal" :prepend-icon="mdiLogout" @click="logout">{{ t('nav.logout') }}</v-btn>
    </div>

    <h2 class="text-title-large mb-4">{{ t('account.changePassword') }}</h2>
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

    <TwoFactorSection />

    <h2 class="text-title-large mt-8 mb-2">{{ t('account.sessions') }}</h2>
    <v-list density="compact">
      <v-list-item
        v-for="s in sessions.data.value"
        :key="s.id"
        :title="s.userAgent ?? t('account.unknownDevice')"
        :subtitle="t('account.lastSeen', { when: formatRelative(s.lastSeenAt, locale) })"
      >
        <template #append>
          <v-chip v-if="s.current" size="small" color="primary" variant="tonal">{{
            t('account.thisDevice')
          }}</v-chip>
          <v-btn v-else size="small" @click="revoke(s.id)">{{ t('account.signOut') }}</v-btn>
        </template>
      </v-list-item>
    </v-list>
  </section>
</template>

<style scoped>
.password-form {
  max-width: 26rem;
}
</style>
