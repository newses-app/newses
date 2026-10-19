<script setup lang="ts">
import { mdiAccountCogOutline, mdiCheck, mdiMenuDown, mdiPlus } from '@mdi/js';
import type { Profile } from '@newses/shared';
import { profileLabel } from '@newses/shared/client';
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { useRouter } from 'vue-router';
import { connection } from '../../platform/index.ts';
import { switchProfile } from '../../platform/profiles.ts';
import ProfileAvatar from './ProfileAvatar.vue';

/** `manage` adds Manage profiles, which needs a session. */
defineProps<{ manage?: boolean }>();

const { t } = useI18n();
const router = useRouter();
const active = computed(() => connection.activeProfile());

function choose(profile: Profile) {
  if (profile.id !== connection.state.active) void switchProfile(profile.id);
}
</script>

<template>
  <v-menu>
    <template #activator="{ props: menu }">
      <slot name="activator" :props="menu">
        <v-list-item
          v-if="active"
          v-bind="menu"
          :title="profileLabel(active)"
          :aria-label="t('profiles.switch', { profile: profileLabel(active) })"
          :append-icon="mdiMenuDown"
          class="py-2"
        >
          <template #prepend><ProfileAvatar :profile="active" class="me-3" /></template>
        </v-list-item>
      </slot>
    </template>
    <v-list density="compact" :aria-label="t('profiles.title')">
      <v-list-item
        v-for="profile in connection.state.profiles"
        :key="profile.id"
        :title="profileLabel(profile)"
        :subtitle="profile.signedIn ? '' : t('profiles.signedOut')"
        :active="profile.id === connection.state.active"
        @click="choose(profile)"
      >
        <template #prepend><ProfileAvatar :profile="profile" :size="28" class="me-3" /></template>
        <template v-if="profile.id === connection.state.active" #append>
          <v-icon :icon="mdiCheck" size="small" />
        </template>
      </v-list-item>
      <v-divider class="my-1" />
      <v-list-item
        :prepend-icon="mdiPlus"
        :title="t('profiles.add')"
        @click="router.push({ name: 'connect' })"
      />
      <v-list-item
        v-if="manage"
        :prepend-icon="mdiAccountCogOutline"
        :title="t('profiles.manage')"
        :to="{ name: 'settings', params: { tab: 'account' } }"
      />
    </v-list>
  </v-menu>
</template>
