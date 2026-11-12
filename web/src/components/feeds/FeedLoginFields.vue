<script setup lang="ts">
import { useI18n } from 'vue-i18n';

/** HTTP Basic credentials of a feed; `saved` when the server holds a password already. */
defineProps<{ saved?: boolean }>();
const login = defineModel<string>('login', { required: true });
const password = defineModel<string>('password', { required: true });

const { t } = useI18n();

/** HTTP Basic cannot send a login with a colon. */
const loginRules = [
  (value: string) => (value.trim() !== '' && !value.includes(':')) || t('feedLogin.loginInvalid'),
];
</script>

<template>
  <v-text-field
    v-model="login"
    :label="t('feedLogin.login')"
    :rules="loginRules"
    dir="auto"
    autocomplete="off"
    autocapitalize="off"
    spellcheck="false"
  />
  <v-text-field
    v-model="password"
    :label="t('feedLogin.password')"
    :hint="saved ? t('feedLogin.passwordSaved') : undefined"
    :persistent-hint="saved"
    type="password"
    dir="auto"
    autocomplete="new-password"
  />
</template>
