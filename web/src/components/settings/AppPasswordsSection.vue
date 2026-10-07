<script setup lang="ts">
import type { AppPassword } from '@rss-reader/shared';
import { mdiContentCopy, mdiDelete, mdiKeyPlus } from '@mdi/js';
import { useQuery, useQueryClient } from '@tanstack/vue-query';
import { ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { api, ApiError } from '../../api.ts';
import { useReturnFocus } from '../../composables/useReturnFocus.ts';
import { formatRelative } from '../../lib/format.ts';
import { useUiStore } from '../../stores/ui.ts';

type Dialog =
  | { kind: 'create'; name: string; password: string }
  | { kind: 'created'; name: string; password: string };

const { t, locale } = useI18n();
const ui = useUiStore();
const queryClient = useQueryClient();
const appPasswords = useQuery({
  queryKey: ['appPasswords'],
  queryFn: () => api.auth.appPasswords.list(),
});

const dialog = ref<Dialog | null>(null);
const busy = ref(false);
const error = ref<string | null>(null);
const restoreFocus = useReturnFocus(() => dialog.value !== null);

async function create() {
  const current = dialog.value;
  if (current?.kind !== 'create') {
    dialog.value = null;
    return;
  }
  busy.value = true;
  error.value = null;
  try {
    const created = await api.auth.appPasswords.create({
      name: current.name.trim(),
      password: current.password,
    });
    dialog.value = { kind: 'created', name: created.appPassword.name, password: created.password };
  } catch (err) {
    const status = err instanceof ApiError ? err.status : null;
    error.value =
      status === 401
        ? t('account.wrongPassword')
        : status === 429
          ? t('account.throttled')
          : err instanceof ApiError
            ? err.message
            : t('errors.generic');
  } finally {
    busy.value = false;
    await queryClient.invalidateQueries({ queryKey: ['appPasswords'] });
  }
}

async function copy(password: string) {
  try {
    await navigator.clipboard.writeText(password);
    ui.notify(t('appPasswords.copied'));
  } catch {
    ui.notify(t('errors.generic'), true);
  }
}

async function revoke(appPassword: AppPassword) {
  if (
    !(await ui.confirm(
      t('appPasswords.revoke'),
      t('appPasswords.revokeConfirm', { name: appPassword.name }),
      t('appPasswords.revoke'),
    ))
  )
    return;
  try {
    await api.auth.appPasswords.revoke(appPassword.id);
  } catch (err) {
    ui.notify(err instanceof ApiError ? err.message : t('errors.generic'), true);
  }
  await queryClient.invalidateQueries({ queryKey: ['appPasswords'] });
}
</script>

<template>
  <section>
    <div class="d-flex align-center mt-8 mb-2">
      <h2 class="text-title-large">{{ t('appPasswords.title') }}</h2>
      <v-spacer />
      <v-btn
        :prepend-icon="mdiKeyPlus"
        @click="
          error = null;
          dialog = { kind: 'create', name: '', password: '' };
        "
        >{{ t('appPasswords.create') }}</v-btn
      >
    </div>
    <p class="text-body-medium mb-2">{{ t('appPasswords.summary') }}</p>
    <v-list v-if="appPasswords.data.value?.length" density="compact">
      <v-list-item
        v-for="appPassword in appPasswords.data.value"
        :key="appPassword.id"
        :title="appPassword.name"
        :subtitle="
          appPassword.lastUsedAt
            ? t('appPasswords.lastUsed', { when: formatRelative(appPassword.lastUsedAt, locale) })
            : t('appPasswords.neverUsed')
        "
      >
        <template #append>
          <v-btn
            :icon="mdiDelete"
            size="small"
            :aria-label="t('appPasswords.revokeNamed', { name: appPassword.name })"
            @click="revoke(appPassword)"
          />
        </template>
      </v-list-item>
    </v-list>
    <p v-else-if="appPasswords.data.value" class="text-body-medium text-medium-emphasis">
      {{ t('appPasswords.none') }}
    </p>

    <v-dialog
      :model-value="dialog !== null"
      max-width="460"
      :persistent="dialog?.kind === 'created'"
      @update:model-value="(v) => !v && (dialog = null)"
      @after-leave="restoreFocus"
    >
      <v-card v-if="dialog" :title="t('appPasswords.create')">
        <v-form @submit.prevent="create">
          <v-card-text v-if="dialog.kind === 'create'">
            <v-text-field
              v-model="dialog.name"
              :label="t('appPasswords.name')"
              :hint="t('appPasswords.nameHint')"
              autocomplete="off"
              autofocus
              maxlength="64"
            />
            <v-text-field
              v-model="dialog.password"
              type="password"
              :label="t('account.currentPassword')"
              autocomplete="current-password"
            />
            <v-alert v-if="error" type="error" variant="tonal" density="compact">{{
              error
            }}</v-alert>
          </v-card-text>
          <v-card-text v-else>
            <p class="text-body-medium mb-4">
              {{ t('appPasswords.createdPrompt', { name: dialog.name }) }}
            </p>
            <code class="d-block mb-4 password">{{ dialog.password }}</code>
            <v-btn :prepend-icon="mdiContentCopy" @click="copy(dialog.password)">{{
              t('twoFactor.copy')
            }}</v-btn>
          </v-card-text>
          <v-card-actions>
            <v-spacer />
            <template v-if="dialog.kind === 'create'">
              <v-btn @click="dialog = null">{{ t('common.cancel') }}</v-btn>
              <v-btn
                type="submit"
                color="primary"
                variant="flat"
                :loading="busy"
                :disabled="!dialog.name.trim() || !dialog.password"
                >{{ t('appPasswords.create') }}</v-btn
              >
            </template>
            <v-btn v-else type="submit" color="primary" variant="flat">{{
              t('common.close')
            }}</v-btn>
          </v-card-actions>
        </v-form>
      </v-card>
    </v-dialog>
  </section>
</template>

<style scoped>
.password {
  font-size: 1.1rem;
  word-break: break-all;
}
</style>
