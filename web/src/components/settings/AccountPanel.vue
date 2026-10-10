<script setup lang="ts">
import { mdiLogout } from '@mdi/js';
import { useQuery, useQueryClient } from '@tanstack/vue-query';
import { useI18n } from 'vue-i18n';
import { api, ApiError } from '../../api.ts';
import { useSession } from '../../composables/useSession.ts';
import { formatRelative } from '../../lib/format.ts';
import { bridge, connection, NATIVE } from '../../platform/index.ts';
import { useUiStore } from '../../stores/ui.ts';
import AppPasswordsSection from './AppPasswordsSection.vue';
import PasswordForm from './PasswordForm.vue';
import TwoFactorSection from './TwoFactorSection.vue';

const { t, locale } = useI18n();
const ui = useUiStore();
const queryClient = useQueryClient();
const { session, logout } = useSession();
const sessions = useQuery({ queryKey: ['sessions'], queryFn: () => api.auth.sessions() });

async function passwordChanged() {
  ui.notify(t('account.passwordChanged'));
  await queryClient.invalidateQueries({ queryKey: ['sessions'] });
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

    <template v-if="NATIVE">
      <h2 class="text-title-large mb-2">{{ t('connect.app') }}</h2>
      <v-list density="compact" class="mb-6">
        <v-list-item :title="t('connect.server')" :subtitle="connection.state.serverUrl ?? ''">
          <template #append>
            <v-btn variant="tonal" size="small" :to="{ name: 'connect' }">
              {{ t('connect.change') }}
            </v-btn>
          </template>
        </v-list-item>
        <v-list-item
          v-if="bridge.appVersion"
          :title="t('connect.appVersion', { version: bridge.appVersion })"
        />
      </v-list>
    </template>

    <h2 class="text-title-large mb-4">{{ t('account.changePassword') }}</h2>
    <PasswordForm @changed="passwordChanged" />

    <TwoFactorSection />

    <AppPasswordsSection />

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
