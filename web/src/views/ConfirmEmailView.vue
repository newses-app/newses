<script setup lang="ts">
import { ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { useRoute } from 'vue-router';
import { api } from '../api.ts';
import { useDocumentTitle } from '../composables/useDocumentTitle.ts';
import { useErrorText } from '../composables/useErrorText.ts';

const { t } = useI18n();
const errorText = useErrorText();
const route = useRoute();
useDocumentTitle(() => t('email.confirmTitle'));

// The token is the link's fragment, which no server, proxy, or log sees. Confirming takes a click,
// as mail scanners open links, and some run their scripts.
const token = route.hash.slice(1);
const busy = ref(false);
const confirmed = ref<string | null>(null);
const error = ref<string | null>(token ? null : t('errors.reason.email_link_invalid'));

async function confirm() {
  busy.value = true;
  error.value = null;
  try {
    // A browser signed in here sends its session cookie, which needs the session's CSRF token.
    await api.auth.session().catch(() => null);
    confirmed.value = (await api.account.confirmEmail(token)).email;
  } catch (err) {
    error.value = errorText(err);
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <v-main>
    <div class="window-drag-strip" aria-hidden="true" />
    <v-container class="fill-height d-flex align-center justify-center">
      <v-card width="420" class="pa-2" elevation="2">
        <v-card-item>
          <div class="d-flex align-center ga-3">
            <img src="/favicon.svg" alt="" width="40" height="40" />
            <v-card-title tag="h1" class="pa-0 text-wrap">{{
              t('email.confirmTitle')
            }}</v-card-title>
          </div>
        </v-card-item>
        <v-card-text>
          <p v-if="confirmed" class="text-body-medium">
            {{ t('email.confirmedText', { email: confirmed }) }}
          </p>
          <template v-else>
            <p class="text-body-medium mb-4">{{ t('email.confirmText') }}</p>
            <v-alert v-if="error" type="error" variant="tonal" density="compact">{{
              error
            }}</v-alert>
          </template>
        </v-card-text>
        <v-card-actions>
          <v-spacer />
          <v-btn v-if="confirmed" color="primary" variant="flat" to="/all">
            {{ t('email.openApp') }}
          </v-btn>
          <v-btn v-else-if="token" color="primary" variant="flat" :loading="busy" @click="confirm">
            {{ t('email.confirmAction') }}
          </v-btn>
        </v-card-actions>
      </v-card>
    </v-container>
  </v-main>
</template>
