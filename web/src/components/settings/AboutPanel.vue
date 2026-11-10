<script setup lang="ts">
import { mdiOpenInNew } from '@mdi/js';
import type { Credit, ThirdPartyLicense } from '@newses/shared';
import {
  CREDIT_KINDS,
  CREDITS,
  mitLicense,
  PLATFORM_LICENSES_FILE,
  THIRD_PARTY_LICENSES_FILE,
} from '@newses/shared/client';
import { sourceAt } from '@newses/shared/release';
import { useQuery } from '@tanstack/vue-query';
import { computed, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { api } from '../../api.ts';
import { useReturnFocus } from '../../composables/useReturnFocus.ts';
import { bundledLicenses, filterLicenses } from '../../lib/licenses.ts';
import { supportsApiMinor } from '../../lib/server-url.ts';
import { bridge, connection, NATIVE, updates } from '../../platform/index.ts';
import { updateSummary } from '../../platform/updates.ts';

/** Signed out (the public About page), the server's packages are not listed. */
const props = defineProps<{ signedIn: boolean }>();

const { t } = useI18n();

/** The API minor that added the server's source link and its packages' licences. */
const LICENSES_API_MINOR = 9;
const AGPL_URL = 'https://www.gnu.org/licenses/agpl-3.0.html';

const update = computed(() => updateSummary(updates.status.value));
const checking = computed(() => updates.status.value.state === 'checking');
function updateAction() {
  void (update.value.action === 'check' ? updates.check() : updates.install());
}

const serverInfo = useQuery({
  queryKey: ['server-info'],
  queryFn: () => api.serverInfo(),
  enabled: !NATIVE || Boolean(connection.state.serverUrl),
  staleTime: Infinity,
});
const info = computed(() => serverInfo.data.value);
const serverHost = computed(() =>
  NATIVE ? new URL(connection.state.serverUrl ?? location.href).host : location.host,
);
const recent = computed(() =>
  info.value ? supportsApiMinor(info.value, LICENSES_API_MINOR) : false,
);
// The apps' own source is the release they were built from; the web app is the server's.
const appSource = computed(() =>
  NATIVE && bridge.appVersion ? sourceAt(NEWSES_REPOSITORY, bridge.appVersion) : null,
);

const appLicenses = useQuery({
  queryKey: ['licenses', 'app'],
  queryFn: () => bundledLicenses(THIRD_PARTY_LICENSES_FILE),
  staleTime: Infinity,
});
const platformLicenses = useQuery({
  queryKey: ['licenses', 'platform'],
  queryFn: () => bundledLicenses(PLATFORM_LICENSES_FILE),
  enabled: NATIVE,
  staleTime: Infinity,
});
const serverLicenses = useQuery({
  queryKey: ['licenses', 'server'],
  // Development servers have none.
  queryFn: () => api.serverLicenses().catch(() => null),
  enabled: computed(() => props.signedIn && recent.value),
  staleTime: Infinity,
});

type Group = 'app' | 'desktop' | 'android' | 'server';
const groups = computed(() => {
  const list: { key: Group; licenses: ThirdPartyLicense[] | null | undefined }[] = [
    { key: 'app', licenses: appLicenses.data.value },
  ];
  if (bridge.platform !== 'web') {
    list.push({ key: bridge.platform, licenses: platformLicenses.data.value });
  }
  if (props.signedIn) list.push({ key: 'server', licenses: serverLicenses.data.value });
  return list;
});
const group = ref<Group>('app');
const filter = ref('');
const shown = computed(() => {
  const licenses = groups.value.find((entry) => entry.key === group.value)?.licenses;
  return licenses ? filterLicenses(licenses, filter.value) : licenses;
});
const loading = computed(
  () =>
    ({
      app: appLicenses.isLoading.value,
      desktop: platformLicenses.isLoading.value,
      android: platformLicenses.isLoading.value,
      server: serverInfo.isLoading.value || serverLicenses.isLoading.value,
    })[group.value],
);

const creditsByKind = computed(() =>
  CREDIT_KINDS.map((kind) => ({
    kind,
    credits: Object.values(CREDITS).filter((credit: Credit) => credit.kind === kind),
  })),
);

/** The licence open in the dialog; `missing` says why it has no text. */
const reading = ref<{
  name: string;
  license: string;
  text?: string | undefined;
  notice?: string | undefined;
  url?: string | undefined;
  missing?: 'noText' | 'notInBuild';
} | null>(null);
const restoreFocus = useReturnFocus(() => reading.value !== null);

function readPackage(entry: ThirdPartyLicense) {
  reading.value = { ...entry, missing: 'noText' };
}

/** A credit's package as this build bundles it, its MIT text, or else its site. */
function readCredit(credit: Credit) {
  const bundled = groups.value
    .flatMap((entry) => entry.licenses ?? [])
    .find((entry) => entry.name === credit.package);
  if (bundled) readPackage(bundled);
  else if (credit.copyright) {
    reading.value = {
      name: credit.name,
      license: credit.license,
      text: mitLicense(credit.copyright),
    };
  } else {
    reading.value = {
      name: credit.name,
      license: credit.license,
      url: credit.url,
      missing: 'notInBuild',
    };
  }
}
</script>

<template>
  <div>
    <div class="d-flex align-center ga-3 mb-4">
      <img src="/favicon.svg" alt="" width="40" height="40" />
      <h2 class="text-title-large">{{ t('app.name') }}</h2>
    </div>
    <v-list density="compact" class="mb-6">
      <!-- The action sits below the text, so narrow screens never cover the version. -->
      <v-list-item v-if="bridge.appVersion">
        <v-list-item-title class="text-wrap">
          {{ t('connect.appVersion', { version: bridge.appVersion }) }}
        </v-list-item-title>
        <v-list-item-subtitle v-if="update.message" class="text-wrap">
          {{ t(`updates.${update.message}`, update.params) }}
        </v-list-item-subtitle>
        <v-btn
          v-if="update.action"
          class="mt-2"
          variant="tonal"
          size="small"
          :loading="checking"
          @click="updateAction"
        >
          {{ t(`updates.${update.action}`) }}
        </v-btn>
      </v-list-item>
      <v-list-item v-if="info">
        <v-list-item-title class="text-wrap">
          {{ t('connect.serverVersion', { host: serverHost, version: info.version }) }}
        </v-list-item-title>
        <v-list-item-subtitle v-if="info.name" class="text-wrap">
          <bdi>{{ info.name }}</bdi>
        </v-list-item-subtitle>
      </v-list-item>
    </v-list>

    <h2 class="text-title-large mb-2">{{ t('about.license') }}</h2>
    <div class="text-body-medium mb-6">
      <p class="mb-2">{{ t('about.copyright') }}</p>
      <p class="mb-2">{{ t('about.licenseNotice') }}</p>
      <p class="mb-4">{{ t('about.warranty') }}</p>
      <div class="d-flex flex-wrap ga-2">
        <v-btn
          variant="tonal"
          size="small"
          :href="AGPL_URL"
          target="_blank"
          rel="noopener"
          :append-icon="mdiOpenInNew"
        >
          {{ t('about.licenseLink') }}
        </v-btn>
        <v-btn
          v-if="appSource"
          variant="tonal"
          size="small"
          :href="appSource"
          target="_blank"
          rel="noopener"
          :append-icon="mdiOpenInNew"
        >
          {{ t('about.appSource') }}
        </v-btn>
        <v-btn
          v-if="info?.source"
          variant="tonal"
          size="small"
          :href="info.source"
          target="_blank"
          rel="noopener"
          :append-icon="mdiOpenInNew"
        >
          {{ NATIVE ? t('about.serverSource') : t('about.source') }}
        </v-btn>
      </div>
    </div>

    <h2 class="text-title-large mb-2">{{ t('about.credits') }}</h2>
    <p class="text-body-medium mb-2">{{ t('about.creditsIntro') }}</p>
    <v-list density="compact" class="mb-6">
      <template v-for="{ kind, credits } in creditsByKind" :key="kind">
        <v-list-subheader>{{ t(`about.kinds.${kind}`) }}</v-list-subheader>
        <v-list-item
          v-for="credit in credits"
          :key="credit.name"
          :subtitle="[credit.author, credit.license].join(t('common.detailSeparator'))"
          @click="readCredit(credit)"
        >
          <v-list-item-title>{{ credit.name }}</v-list-item-title>
        </v-list-item>
      </template>
    </v-list>

    <h2 class="text-title-large mb-2">{{ t('about.licenses') }}</h2>
    <p class="text-body-medium mb-4">{{ t('about.licensesIntro') }}</p>
    <v-chip-group v-model="group" mandatory selected-class="text-primary" class="mb-2">
      <v-chip v-for="entry in groups" :key="entry.key" :value="entry.key" filter>
        {{ t(`about.groups.${entry.key}`) }}
      </v-chip>
    </v-chip-group>
    <v-text-field
      v-model="filter"
      :label="t('about.filter')"
      dir="ltr"
      density="compact"
      clearable
      hide-details
      spellcheck="false"
      class="mb-2"
    />
    <p v-if="loading" class="text-body-medium py-4">{{ t('common.loading') }}</p>
    <p v-else-if="group === 'server' && info && !recent" class="text-body-medium py-4">
      {{ t('about.serverOlder') }}
    </p>
    <p v-else-if="!shown" class="text-body-medium py-4">{{ t('about.unavailable') }}</p>
    <template v-else>
      <p class="text-body-small text-medium-emphasis py-2" aria-live="polite">
        {{ t('about.packageCount', { n: shown.length }, shown.length) }}
      </p>
      <v-list density="compact">
        <v-list-item
          v-for="entry in shown"
          :key="`${entry.name}@${entry.version}`"
          :subtitle="entry.license"
          @click="readPackage(entry)"
        >
          <v-list-item-title dir="ltr" class="text-start">
            {{ entry.name }} {{ entry.version }}
          </v-list-item-title>
        </v-list-item>
      </v-list>
    </template>

    <v-dialog
      :model-value="reading !== null"
      max-width="760"
      scrollable
      @update:model-value="reading = null"
      @after-leave="restoreFocus"
    >
      <v-card v-if="reading">
        <v-card-title dir="ltr" class="text-start text-wrap">{{ reading.name }}</v-card-title>
        <v-card-subtitle>{{ reading.license }}</v-card-subtitle>
        <!-- Focusable so keyboard users can scroll a long licence. -->
        <v-card-text tabindex="0">
          <pre v-if="reading.notice" dir="ltr" class="license-text mb-4">{{ reading.notice }}</pre>
          <pre v-if="reading.text" dir="ltr" class="license-text">{{ reading.text }}</pre>
          <template v-else>
            <p v-if="reading.missing" class="text-body-medium mb-2">
              {{ t(`about.${reading.missing}`) }}
            </p>
            <a v-if="reading.url" :href="reading.url" target="_blank" rel="noopener" dir="ltr">{{
              reading.url
            }}</a>
          </template>
        </v-card-text>
        <v-card-actions>
          <v-spacer />
          <v-btn @click="reading = null">{{ t('common.close') }}</v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>
  </div>
</template>

<style scoped>
.license-text {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  font-size: 0.8125rem;
}
</style>
