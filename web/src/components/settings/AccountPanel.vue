<script setup lang="ts">
import { mdiDotsVertical, mdiLogout, mdiPlus } from '@mdi/js';
import type { DesktopOptions, Profile } from '@newses/shared';
import { MAX_PROFILE_LABEL_LENGTH, profileLabel } from '@newses/shared/client';
import { useQuery, useQueryClient } from '@tanstack/vue-query';
import { computed, onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { api, ApiError } from '../../api.ts';
import { useSession } from '../../composables/useSession.ts';
import { formatRelative, formatStorage } from '../../lib/format.ts';
import { syncRequests } from '../../offline/status.ts';
import { bridge, connection, desktop, NATIVE, updates } from '../../platform/index.ts';
import {
  clearProfileStore,
  pendingChanges,
  profileStoredBytes,
  removeProfile,
  switchProfile,
} from '../../platform/profiles.ts';
import { updateSummary } from '../../platform/updates.ts';
import { useUiStore } from '../../stores/ui.ts';
import ProfileAvatar from '../profiles/ProfileAvatar.vue';
import AppPasswordsSection from './AppPasswordsSection.vue';
import PasswordForm from './PasswordForm.vue';
import TwoFactorSection from './TwoFactorSection.vue';

const { t, locale } = useI18n();
const ui = useUiStore();
const queryClient = useQueryClient();
const { session, logout } = useSession();
const sessions = useQuery({ queryKey: ['sessions'], queryFn: () => api.auth.sessions() });
const update = computed(() => updateSummary(updates.status.value));
const checking = computed(() => updates.status.value.state === 'checking');

const desktopOptions = computed(() => desktop.options.value);
const DESKTOP_OPTIONS: (keyof DesktopOptions)[] = ['notifications', 'closeToTray', 'launchAtLogin'];
/** The options this install offers: the Windows portable exe does not start at login. */
const shownDesktopOptions = computed(() =>
  DESKTOP_OPTIONS.filter((key) => desktopOptions.value?.[key] !== undefined),
);

function setOption(key: keyof DesktopOptions, value: boolean | null | undefined) {
  void desktop.set({ [key]: value === true });
}

function updateAction() {
  void (update.value.action === 'check' ? updates.check() : updates.install());
}

async function passwordChanged() {
  ui.notify(t('account.passwordChanged'));
  await queryClient.invalidateQueries({ queryKey: ['sessions'] });
}

/** What each profile's articles and images take on the device; absent without a store. */
const stored = ref(new Map<string, number>());

async function measure() {
  const sizes = await Promise.all(
    connection.state.profiles.map(async (p) => [p.id, await profileStoredBytes(p)] as const),
  );
  stored.value = new Map(sizes.filter((entry): entry is [string, number] => entry[1] !== null));
}
onMounted(() => {
  if (NATIVE) void measure();
});

/** Its server, whether it is the one in use or signed out, and the space it takes. */
const profileDetails = (profile: Profile) => {
  const bytes = stored.value.get(profile.id);
  return [
    new URL(profile.serverUrl).host,
    profile.id === connection.state.active && t('profiles.current'),
    !profile.signedIn && t('profiles.signedOut'),
    bytes !== undefined && t('profiles.stored', { size: formatStorage(bytes, locale.value) }),
  ]
    .filter(Boolean)
    .join(' · ');
};

/** Deletes a profile's downloaded articles, which download again when it next syncs. */
async function clearData(profile: Profile) {
  const pending = await pendingChanges(profile);
  const text =
    pending > 0
      ? `${t('profiles.clearText')} ${t('offline.clearPending', { n: pending }, pending)}`
      : t('profiles.clearText');
  const title = t('profiles.clearTitle', { profile: profileLabel(profile) });
  if (!(await ui.confirm(title, text, t('profiles.clear')))) return;
  await clearProfileStore(profile);
  if (profile.id === connection.state.active) syncRequests.value++;
  await measure();
}

const renaming = ref<Profile | null>(null);
const label = ref('');

function startRename(profile: Profile) {
  renaming.value = profile;
  label.value = profile.label ?? '';
}

async function rename() {
  const profile = renaming.value;
  renaming.value = null;
  if (!profile) return;
  await bridge.updateProfile(profile.id, { label: label.value.trim() || null });
  await connection.refresh();
}

/** Removing deletes what the device kept for the profile; the reader confirms, told what is lost. */
async function remove(profile: Profile) {
  await removeProfile(profile, (pending) =>
    ui.confirm(
      t('profiles.removeTitle', { profile: profileLabel(profile) }),
      pending > 0 ? t('profiles.removePending', { n: pending }, pending) : t('profiles.removeText'),
      t('profiles.remove'),
    ),
  );
}

async function revoke(id: number) {
  try {
    await api.auth.revokeSession(id);
  } catch (err) {
    ui.notify(err instanceof ApiError ? err.message : t('errors.generic'), true);
  }
  await queryClient.invalidateQueries({ queryKey: ['sessions'] });
}
</script>

<template>
  <section>
    <div class="d-flex align-center mb-6">
      <div>
        <h2 class="text-title-large">{{ session?.user.login }}</h2>
        <p class="text-body-medium text-medium-emphasis">
          {{ t(`account.roles.${session?.user.role ?? 'user'}`) }}
        </p>
      </div>
      <v-spacer />
      <v-btn variant="tonal" :prepend-icon="mdiLogout" @click="logout">{{ t('nav.logout') }}</v-btn>
    </div>

    <template v-if="NATIVE">
      <h2 class="text-title-large mb-2">{{ t('profiles.title') }}</h2>
      <v-list density="compact" class="mb-2">
        <v-list-item
          v-for="profile in connection.state.profiles"
          :key="profile.id"
          :title="profileLabel(profile)"
          :subtitle="profileDetails(profile)"
        >
          <template #prepend><ProfileAvatar :profile="profile" class="me-3" /></template>
          <template #append>
            <v-menu>
              <template #activator="{ props: menu }">
                <v-btn
                  :icon="mdiDotsVertical"
                  variant="text"
                  size="small"
                  :aria-label="t('profiles.actions', { profile: profileLabel(profile) })"
                  v-bind="menu"
                />
              </template>
              <v-list density="compact">
                <v-list-item
                  v-if="profile.id !== connection.state.active"
                  :title="t('profiles.switchTo')"
                  @click="switchProfile(profile.id)"
                />
                <v-list-item :title="t('profiles.rename')" @click="startRename(profile)" />
                <v-list-item
                  v-if="stored.has(profile.id)"
                  :title="t('profiles.clear')"
                  @click="clearData(profile)"
                />
                <v-list-item :title="t('profiles.remove')" @click="remove(profile)" />
              </v-list>
            </v-menu>
          </template>
        </v-list-item>
      </v-list>
      <v-btn
        variant="tonal"
        size="small"
        class="mb-6"
        :prepend-icon="mdiPlus"
        :to="{ name: 'connect' }"
      >
        {{ t('profiles.add') }}
      </v-btn>
      <v-dialog
        :model-value="renaming !== null"
        max-width="420"
        @update:model-value="renaming = null"
      >
        <v-card :title="t('profiles.rename')">
          <v-form @submit.prevent="rename">
            <v-card-text>
              <v-text-field
                v-model="label"
                :label="t('profiles.label')"
                :placeholder="renaming ? profileLabel({ ...renaming, label: null }) : undefined"
                :maxlength="MAX_PROFILE_LABEL_LENGTH"
                autofocus
              />
            </v-card-text>
            <v-card-actions>
              <v-spacer />
              <v-btn @click="renaming = null">{{ t('common.cancel') }}</v-btn>
              <v-btn type="submit" color="primary" variant="flat">{{ t('common.save') }}</v-btn>
            </v-card-actions>
          </v-form>
        </v-card>
      </v-dialog>

      <h2 class="text-title-large mb-2">{{ t('connect.app') }}</h2>
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
      </v-list>
      <div v-if="desktopOptions" class="mb-6">
        <v-switch
          v-for="key in shownDesktopOptions"
          :key="key"
          :model-value="desktopOptions[key] === true"
          :label="t(`desktop.${key}`)"
          color="primary"
          density="compact"
          hide-details
          @update:model-value="setOption(key, $event)"
        />
      </div>
    </template>

    <h2 class="text-title-large mb-4">{{ t('account.changePassword') }}</h2>
    <PasswordForm @changed="passwordChanged" />

    <TwoFactorSection />

    <AppPasswordsSection />

    <h2 class="text-title-large mt-8 mb-2">{{ t('account.sessions') }}</h2>
    <v-list density="compact">
      <v-list-item
        v-for="s in sessions.data.value"
        :key="s.id"
        :title="s.userAgent ?? t('account.unknownDevice')"
        :subtitle="t('account.lastSeen', { when: formatRelative(s.lastSeenAt, locale) })"
      >
        <template #append>
          <v-chip v-if="s.current" size="small" color="primary" variant="tonal">{{
            t('account.thisDevice')
          }}</v-chip>
          <v-btn v-else size="small" @click="revoke(s.id)">{{ t('account.signOut') }}</v-btn>
        </template>
      </v-list-item>
    </v-list>
  </section>
</template>
