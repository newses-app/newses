<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { useRouter } from 'vue-router';
import { useDocumentTitle } from '../composables/useDocumentTitle.ts';
import { checkServer, normaliseServerUrl } from '../lib/server-url.ts';
import { bridge, connection } from '../platform/index.ts';
import { connectTo } from '../platform/profiles.ts';

const { t } = useI18n();
const router = useRouter();
/** With a profile already, the screen adds another server, or goes to a known one's profile. */
const title = connection.state.profiles.length > 0 ? t('connect.addTitle') : t('connect.title');
useDocumentTitle(() => title);

/** Set when changing server from settings or the sign-in page. */
const current = connection.state.serverUrl;
const address = ref(current ?? '');
const busy = ref(false);
const error = ref<string | null>(null);
/** A reachable server with an older API, waiting for the user to continue anyway. */
const older = ref<{ origin: string; version: string; name: string | null } | null>(null);
const addressField = ref<{ focus: () => void } | null>(null);
onMounted(() => addressField.value?.focus());

/** Another server moves the app to its profile; the current one stays signed in. */
async function use(origin: string, name: string | null) {
  if (origin === current) await router.replace(connection.state.token ? '/all' : { name: 'login' });
  else await connectTo(origin, name);
}

async function submit() {
  error.value = null;
  older.value = null;
  const origin = normaliseServerUrl(address.value);
  if (!origin) {
    error.value = t('connect.invalid');
    return;
  }
  busy.value = true;
  try {
    const result = await checkServer(origin);
    if (result.status === 'ok') await use(origin, result.info.name ?? null);
    else if (result.status === 'older')
      older.value = { origin, version: result.info.version, name: result.info.name ?? null };
    else error.value = t(`connect.${result.status}`, { host: new URL(origin).host });
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
            <v-card-title tag="h1" class="pa-0">{{ title }}</v-card-title>
          </div>
        </v-card-item>
        <v-form @submit.prevent="submit">
          <v-card-text>
            <p class="text-body-medium mb-4">{{ t('connect.prompt') }}</p>
            <v-text-field
              ref="addressField"
              v-model="address"
              :label="t('connect.address')"
              :placeholder="t('connect.placeholder')"
              :hint="current ? t('connect.changeHint') : undefined"
              persistent-hint
              type="url"
              inputmode="url"
              autocomplete="url"
              autocapitalize="off"
              spellcheck="false"
              required
            />
            <v-alert v-if="error" type="error" variant="tonal" density="compact" class="mt-4">
              {{ error }}
            </v-alert>
            <v-alert v-if="older" type="warning" variant="tonal" density="compact" class="mt-4">
              {{ t('connect.older', { version: older.version }) }}
            </v-alert>
          </v-card-text>
          <v-card-actions>
            <v-btn
              v-if="older"
              color="primary"
              variant="flat"
              block
              size="large"
              @click="use(older.origin, older.name)"
            >
              {{ t('connect.continue') }}
            </v-btn>
            <v-btn
              v-else
              type="submit"
              color="primary"
              variant="flat"
              block
              size="large"
              :loading="busy"
              :disabled="!address.trim()"
            >
              {{ t('connect.submit') }}
            </v-btn>
          </v-card-actions>
          <v-card-actions v-if="current" class="pt-0">
            <v-btn variant="text" block @click="router.back()">{{ t('common.cancel') }}</v-btn>
          </v-card-actions>
        </v-form>
        <p v-if="bridge.appVersion" class="text-body-small text-medium-emphasis text-center pb-2">
          {{ t('connect.appVersion', { version: bridge.appVersion }) }}
        </p>
      </v-card>
    </v-container>
  </v-main>
</template>
