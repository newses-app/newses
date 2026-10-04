<script setup lang="ts">
import type { User } from '@rss-reader/shared';
import { mdiAccountPlus, mdiDelete, mdiLockReset } from '@mdi/js';
import { useQuery, useQueryClient } from '@tanstack/vue-query';
import { ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { api, ApiError } from '../../api.ts';
import { useSession } from '../../composables/useSession.ts';
import { formatRelative } from '../../lib/format.ts';
import { useUiStore } from '../../stores/ui.ts';

const { t, locale } = useI18n();
const ui = useUiStore();
const queryClient = useQueryClient();
const { session } = useSession();
const users = useQuery({ queryKey: ['admin', 'users'], queryFn: () => api.admin.users() });

async function run(work: () => Promise<unknown>, done?: string) {
  try {
    await work();
    if (done) ui.notify(done);
    return true;
  } catch (error) {
    ui.notify(error instanceof ApiError ? error.message : t('errors.generic'), true);
    return false;
  } finally {
    await queryClient.invalidateQueries({ queryKey: ['admin', 'users'] });
  }
}

function update(user: User, changes: { role?: 'admin' | 'user'; disabled?: boolean }) {
  void run(() => api.admin.updateUser(user.id, changes));
}

const creating = ref<{ login: string; password: string; admin: boolean } | null>(null);
async function create() {
  const value = creating.value;
  if (!value) return;
  if (
    await run(() =>
      api.admin.createUser({
        login: value.login.trim(),
        password: value.password,
        role: value.admin ? 'admin' : 'user',
      }),
    )
  )
    creating.value = null;
}

const resetting = ref<{ user: User; password: string } | null>(null);
async function resetPassword() {
  const value = resetting.value;
  if (!value) return;
  if (
    await run(
      () => api.admin.resetPassword(value.user.id, value.password),
      t('users.passwordReset'),
    )
  )
    resetting.value = null;
}

async function remove(user: User) {
  if (
    await ui.confirm(
      t('users.delete'),
      t('users.deleteConfirm', { login: user.login }),
      t('common.delete'),
    )
  )
    await run(() => api.admin.deleteUser(user.id));
}
</script>

<template>
  <section>
    <div class="d-flex align-center mb-4">
      <h2 class="text-title-large">{{ t('settings.tabs.users') }}</h2>
      <v-spacer />
      <v-btn
        color="primary"
        variant="flat"
        :prepend-icon="mdiAccountPlus"
        @click="creating = { login: '', password: '', admin: false }"
      >
        {{ t('users.create') }}
      </v-btn>
    </div>
    <v-table density="compact">
      <thead>
        <tr>
          <th>{{ t('login.name') }}</th>
          <th>{{ t('users.admin') }}</th>
          <th>{{ t('users.enabled') }}</th>
          <th class="d-none d-sm-table-cell">{{ t('users.lastLogin') }}</th>
          <th>
            <span class="d-sr-only">{{ t('settings.actions') }}</span>
          </th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="user in users.data.value" :key="user.id">
          <td>{{ user.login }}</td>
          <td>
            <v-checkbox-btn
              :model-value="user.role === 'admin'"
              :aria-label="t('users.admin')"
              @update:model-value="(v) => update(user, { role: v ? 'admin' : 'user' })"
            />
          </td>
          <td>
            <v-checkbox-btn
              :model-value="!user.disabled"
              :disabled="user.id === session?.user.id"
              :aria-label="t('users.enabled')"
              @update:model-value="(v) => update(user, { disabled: !v })"
            />
          </td>
          <td class="d-none d-sm-table-cell text-body-small">
            {{ user.lastLoginAt ? formatRelative(user.lastLoginAt, locale) : t('users.never') }}
          </td>
          <td class="text-no-wrap text-end">
            <v-btn
              :icon="mdiLockReset"
              size="small"
              :aria-label="t('users.resetPassword')"
              @click="resetting = { user, password: '' }"
            />
            <v-btn
              :icon="mdiDelete"
              size="small"
              :disabled="user.id === session?.user.id"
              :aria-label="t('users.delete')"
              @click="remove(user)"
            />
          </td>
        </tr>
      </tbody>
    </v-table>

    <v-dialog
      :model-value="creating !== null"
      max-width="420"
      @update:model-value="(v) => !v && (creating = null)"
    >
      <v-card v-if="creating" :title="t('users.create')">
        <v-form @submit.prevent="create">
          <v-card-text>
            <v-text-field
              v-model="creating.login"
              :label="t('login.name')"
              autocomplete="off"
              autofocus
            />
            <v-text-field
              v-model="creating.password"
              type="password"
              :label="t('login.password')"
              autocomplete="new-password"
              :hint="t('account.passwordHint')"
            />
            <v-checkbox v-model="creating.admin" :label="t('users.admin')" hide-details />
          </v-card-text>
          <v-card-actions>
            <v-spacer />
            <v-btn @click="creating = null">{{ t('common.cancel') }}</v-btn>
            <v-btn
              type="submit"
              color="primary"
              variant="flat"
              :disabled="!creating.login || creating.password.length < 8"
            >
              {{ t('users.create') }}
            </v-btn>
          </v-card-actions>
        </v-form>
      </v-card>
    </v-dialog>

    <v-dialog
      :model-value="resetting !== null"
      max-width="420"
      @update:model-value="(v) => !v && (resetting = null)"
    >
      <v-card
        v-if="resetting"
        :title="t('users.resetPasswordFor', { login: resetting.user.login })"
      >
        <v-form @submit.prevent="resetPassword">
          <v-card-text>
            <v-text-field
              v-model="resetting.password"
              type="password"
              :label="t('account.newPassword')"
              autocomplete="new-password"
              autofocus
              :hint="t('users.resetHint')"
              persistent-hint
            />
          </v-card-text>
          <v-card-actions>
            <v-spacer />
            <v-btn @click="resetting = null">{{ t('common.cancel') }}</v-btn>
            <v-btn
              type="submit"
              color="primary"
              variant="flat"
              :disabled="resetting.password.length < 8"
            >
              {{ t('users.resetPassword') }}
            </v-btn>
          </v-card-actions>
        </v-form>
      </v-card>
    </v-dialog>
  </section>
</template>
