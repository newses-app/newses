<script setup lang="ts">
import { useI18n } from 'vue-i18n';
import { useRouter } from 'vue-router';
import AboutPanel from '../components/settings/AboutPanel.vue';
import { useDocumentTitle } from '../composables/useDocumentTitle.ts';

// Public, from the sign-in and connect pages; signed in, the About tab in Settings has the same.
const { t } = useI18n();
const router = useRouter();
useDocumentTitle(() => t('about.title'));

function back() {
  if (window.history.state?.back) router.back();
  else void router.push({ name: 'login' });
}
</script>

<template>
  <v-main id="main" tabindex="-1">
    <div class="window-drag-strip" aria-hidden="true" />
    <v-container class="about-container">
      <div class="d-flex align-center flex-wrap ga-2 mb-4">
        <h1 class="text-headline-small">{{ t('about.title') }}</h1>
        <v-spacer />
        <v-btn variant="text" @click="back">{{ t('about.back') }}</v-btn>
      </div>
      <AboutPanel :signed-in="false" />
    </v-container>
  </v-main>
</template>

<style scoped>
.about-container {
  max-width: 960px;
}
</style>
