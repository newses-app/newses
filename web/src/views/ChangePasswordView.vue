<script setup lang="ts">
import { useQueryClient } from '@tanstack/vue-query';
import { useI18n } from 'vue-i18n';
import { useRouter } from 'vue-router';
import PasswordForm from '../components/settings/PasswordForm.vue';
import { useDocumentTitle } from '../composables/useDocumentTitle.ts';
import { SESSION_KEY, useSession } from '../composables/useSession.ts';

const { t } = useI18n();
const router = useRouter();
const queryClient = useQueryClient();
const { session, logout } = useSession();
useDocumentTitle(() => t('account.changePassword'));

async function changed() {
  await queryClient.invalidateQueries({ queryKey: SESSION_KEY });
  await router.replace('/all');
}
</script>

<template>
  <v-main>
    <div class="window-drag-strip" aria-hidden="true" />
    <v-container class="fill-height d-flex align-center justify-center">
      <v-card width="420" class="pa-2" elevation="2">
        <v-card-item>
          <v-card-title tag="h1">{{ t('account.changePassword') }}</v-card-title>
          <v-card-subtitle>{{ session?.user.login }}</v-card-subtitle>
        </v-card-item>
        <v-card-text>
          <p class="text-body-medium mb-4">{{ t('account.changeRequired') }}</p>
          <PasswordForm @changed="changed" />
        </v-card-text>
        <v-card-actions>
          <v-btn variant="text" @click="logout">{{ t('nav.logout') }}</v-btn>
        </v-card-actions>
      </v-card>
    </v-container>
  </v-main>
</template>
