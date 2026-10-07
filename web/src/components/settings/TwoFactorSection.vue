<script setup lang="ts">
import type { TwoFactorSetup } from '@rss-reader/shared';
import { mdiContentCopy, mdiDownload } from '@mdi/js';
import { useQuery, useQueryClient } from '@tanstack/vue-query';
import QRCode from 'qrcode';
import { computed, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { api, ApiError } from '../../api.ts';
import { useReturnFocus } from '../../composables/useReturnFocus.ts';
import { useUiStore } from '../../stores/ui.ts';

type Dialog =
  | { kind: 'password'; password: string }
  | { kind: 'scan'; setup: TwoFactorSetup; qr: string; code: string }
  | { kind: 'codes'; codes: string[] }
  | { kind: 'disable'; password: string; code: string }
  | { kind: 'regenerate'; code: string };

const { t } = useI18n();
const ui = useUiStore();
const queryClient = useQueryClient();
const status = useQuery({ queryKey: ['twoFactor'], queryFn: () => api.auth.twoFactor.status() });

const dialog = ref<Dialog | null>(null);
const busy = ref(false);
const error = ref<string | null>(null);
const restoreFocus = useReturnFocus(() => dialog.value !== null);

const title = computed(() => {
  switch (dialog.value?.kind) {
    case 'disable':
      return t('twoFactor.disable');
    case 'regenerate':
    case 'codes':
      return t('twoFactor.recoveryCodes');
    default:
      return t('twoFactor.setUp');
  }
});

function open(next: Dialog) {
  error.value = null;
  dialog.value = next;
}

/** Runs one dialog step; a 401 means the password or code was wrong. */
async function step(work: () => Promise<void>, wrong: string) {
  busy.value = true;
  error.value = null;
  try {
    await work();
  } catch (err) {
    const code = err instanceof ApiError ? err.status : null;
    error.value =
      code === 401 ? wrong : code === 429 ? t('account.throttled') : t('errors.generic');
  } finally {
    busy.value = false;
    await queryClient.invalidateQueries({ queryKey: ['twoFactor'] });
  }
}

function submit() {
  const current = dialog.value;
  if (!current) return;
  switch (current.kind) {
    case 'password':
      return step(async () => {
        const setup = await api.auth.twoFactor.setup(current.password);
        const qr = await QRCode.toDataURL(setup.uri, { margin: 1, width: 200 });
        open({ kind: 'scan', setup, qr, code: '' });
      }, t('account.wrongPassword'));
    case 'scan':
      return step(async () => {
        const { recoveryCodes } = await api.auth.twoFactor.enable(current.code.trim());
        open({ kind: 'codes', codes: recoveryCodes });
        ui.notify(t('twoFactor.enabled'));
        await queryClient.invalidateQueries({ queryKey: ['sessions'] });
      }, t('login.invalidCode'));
    case 'disable':
      return step(async () => {
        await api.auth.twoFactor.disable(current.password, current.code.trim());
        dialog.value = null;
        ui.notify(t('twoFactor.disabled'));
      }, t('twoFactor.wrongPasswordOrCode'));
    case 'regenerate':
      return step(async () => {
        const { recoveryCodes } = await api.auth.twoFactor.regenerateRecoveryCodes(
          current.code.trim(),
        );
        open({ kind: 'codes', codes: recoveryCodes });
      }, t('login.invalidCode'));
    case 'codes':
      dialog.value = null;
  }
}

async function copyCodes(codes: string[]) {
  try {
    await navigator.clipboard.writeText(codes.join('\n'));
    ui.notify(t('twoFactor.copied'));
  } catch {
    ui.notify(t('errors.generic'), true);
  }
}

function downloadCodes(codes: string[]) {
  const url = URL.createObjectURL(new Blob([`${codes.join('\n')}\n`], { type: 'text/plain' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = 'rss-reader-recovery-codes.txt';
  link.click();
  URL.revokeObjectURL(url);
}
</script>

<template>
  <section>
    <h2 class="text-title-large mt-8 mb-2">{{ t('twoFactor.title') }}</h2>
    <template v-if="status.data.value?.enabled">
      <p class="text-body-medium mb-4">
        {{ t('twoFactor.onSummary', { count: status.data.value.recoveryCodesLeft }) }}
      </p>
      <div class="d-flex flex-wrap ga-2">
        <v-btn @click="open({ kind: 'regenerate', code: '' })">{{
          t('twoFactor.newRecoveryCodes')
        }}</v-btn>
        <v-btn variant="tonal" @click="open({ kind: 'disable', password: '', code: '' })">{{
          t('twoFactor.disable')
        }}</v-btn>
      </div>
    </template>
    <template v-else-if="status.data.value">
      <p class="text-body-medium mb-4">{{ t('twoFactor.offSummary') }}</p>
      <v-btn color="primary" variant="flat" @click="open({ kind: 'password', password: '' })">{{
        t('twoFactor.setUp')
      }}</v-btn>
    </template>

    <v-dialog
      :model-value="dialog !== null"
      max-width="460"
      :persistent="dialog?.kind === 'codes'"
      @update:model-value="(v) => !v && (dialog = null)"
      @after-leave="restoreFocus"
    >
      <v-card v-if="dialog" :title="title">
        <v-form @submit.prevent="submit">
          <v-card-text>
            <template v-if="dialog.kind === 'password'">
              <p class="text-body-medium mb-4">{{ t('twoFactor.passwordPrompt') }}</p>
              <v-text-field
                v-model="dialog.password"
                type="password"
                :label="t('account.currentPassword')"
                autocomplete="current-password"
                autofocus
              />
            </template>
            <template v-else-if="dialog.kind === 'scan'">
              <p class="text-body-medium mb-4">{{ t('twoFactor.scanPrompt') }}</p>
              <img
                :src="dialog.qr"
                :alt="t('twoFactor.qrAlt')"
                width="200"
                height="200"
                class="d-block mx-auto mb-4 qr"
              />
              <p class="text-body-small mb-1">{{ t('twoFactor.manualEntry') }}</p>
              <code class="d-block mb-4 secret">{{ dialog.setup.secret }}</code>
              <v-text-field
                v-model="dialog.code"
                :label="t('login.code')"
                autocomplete="one-time-code"
                inputmode="numeric"
                autofocus
              />
            </template>
            <template v-else-if="dialog.kind === 'codes'">
              <p class="text-body-medium mb-4">{{ t('twoFactor.codesPrompt') }}</p>
              <ul class="codes mb-4">
                <li v-for="code in dialog.codes" :key="code">
                  <code>{{ code }}</code>
                </li>
              </ul>
              <div class="d-flex ga-2">
                <v-btn :prepend-icon="mdiContentCopy" @click="copyCodes(dialog.codes)">{{
                  t('twoFactor.copy')
                }}</v-btn>
                <v-btn :prepend-icon="mdiDownload" @click="downloadCodes(dialog.codes)">{{
                  t('twoFactor.download')
                }}</v-btn>
              </div>
            </template>
            <template v-else-if="dialog.kind === 'disable'">
              <v-text-field
                v-model="dialog.password"
                type="password"
                :label="t('account.currentPassword')"
                autocomplete="current-password"
                autofocus
              />
              <v-text-field
                v-model="dialog.code"
                :label="t('login.code')"
                autocomplete="one-time-code"
                :hint="t('twoFactor.codeHint')"
                persistent-hint
              />
            </template>
            <template v-else>
              <p class="text-body-medium mb-4">{{ t('twoFactor.regeneratePrompt') }}</p>
              <v-text-field
                v-model="dialog.code"
                :label="t('login.code')"
                autocomplete="one-time-code"
                autofocus
              />
            </template>
            <v-alert v-if="error" type="error" variant="tonal" density="compact">{{
              error
            }}</v-alert>
          </v-card-text>
          <v-card-actions>
            <v-spacer />
            <v-btn v-if="dialog.kind !== 'codes'" @click="dialog = null">{{
              t('common.cancel')
            }}</v-btn>
            <v-btn type="submit" color="primary" variant="flat" :loading="busy">
              {{
                dialog.kind === 'codes'
                  ? t('twoFactor.savedCodes')
                  : dialog.kind === 'disable'
                    ? t('twoFactor.disable')
                    : dialog.kind === 'password'
                      ? t('twoFactor.continue')
                      : t('login.verify')
              }}
            </v-btn>
          </v-card-actions>
        </v-form>
      </v-card>
    </v-dialog>
  </section>
</template>

<style scoped>
.qr {
  /* Authenticator apps need dark-on-light modules whatever the theme. */
  background: #fff;
  border-radius: 4px;
}
.secret {
  word-break: break-all;
}
.codes {
  columns: 2;
  list-style: none;
  padding: 0;
}
</style>
