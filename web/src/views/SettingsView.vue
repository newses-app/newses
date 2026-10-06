<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { useRoute } from 'vue-router';
import AccountPanel from '../components/settings/AccountPanel.vue';
import FeedsPanel from '../components/settings/FeedsPanel.vue';
import PrefsPanel from '../components/settings/PrefsPanel.vue';
import UsersPanel from '../components/settings/UsersPanel.vue';
import { useDocumentTitle } from '../composables/useDocumentTitle.ts';
import { useSession } from '../composables/useSession.ts';
import { useUiStore } from '../stores/ui.ts';

const { t } = useI18n();
const route = useRoute();
const ui = useUiStore();
const { session } = useSession();

const isAdmin = computed(() => session.value?.user.role === 'admin');
const tabs = computed(() => [
  'preferences',
  'feeds',
  'account',
  ...(isAdmin.value ? ['users'] : []),
]);
const tab = computed(
  () => (typeof route.params.tab === 'string' && route.params.tab) || 'preferences',
);
useDocumentTitle(() => `${t(`settings.tabs.${tab.value}`)} – ${t('nav.settings')}`);
</script>

<template>
  <v-app-bar density="compact" flat border="b">
    <template #prepend>
      <v-app-bar-nav-icon :aria-label="t('nav.menu')" @click="ui.drawer = !ui.drawer" />
    </template>
    <v-app-bar-title tag="h1">{{ t('nav.settings') }}</v-app-bar-title>
    <template #extension>
      <v-tabs :model-value="tab" color="primary">
        <v-tab
          v-for="name in tabs"
          :key="name"
          :value="name"
          :to="{ name: 'settings', params: { tab: name } }"
        >
          {{ t(`settings.tabs.${name}`) }}
        </v-tab>
      </v-tabs>
    </template>
  </v-app-bar>
  <v-main id="main" tabindex="-1">
    <v-container class="settings-container">
      <PrefsPanel v-if="tab === 'preferences'" />
      <FeedsPanel v-else-if="tab === 'feeds'" />
      <AccountPanel v-else-if="tab === 'account'" />
      <UsersPanel v-else-if="tab === 'users' && isAdmin" />
    </v-container>
  </v-main>
</template>

<style scoped>
.settings-container {
  max-width: 960px;
}
</style>
