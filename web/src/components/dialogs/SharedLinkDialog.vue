<script setup lang="ts">
import { mdiMenuDown } from '@mdi/js';
import type { Profile } from '@newses/shared';
import { profileLabel } from '@newses/shared/client';
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { useReturnFocus } from '../../composables/useReturnFocus.ts';
import { connection, NATIVE, shares } from '../../platform/index.ts';
import { switchProfile } from '../../platform/profiles.ts';
import { useUiStore } from '../../stores/ui.ts';
import ProfileAvatar from '../profiles/ProfileAvatar.vue';

const ui = useUiStore();
const { t } = useI18n();
const open = computed({
  get: () => ui.sharedLink !== null,
  set: (value) => {
    if (!value) ui.sharedLink = null;
  },
});
const restoreFocus = useReturnFocus(() => open.value);

/** The page goes to the active profile; with others signed in, the reader can move it to one. */
const target = computed(() => (NATIVE ? connection.activeProfile() : null));
const others = computed(() =>
  connection.state.profiles.filter((p) => p.signedIn && p.id !== connection.state.active),
);

/** Offers the page again in the other profile, after the app reloads on it. */
function moveTo(profile: Profile) {
  const link = ui.sharedLink;
  ui.sharedLink = null;
  if (link) shares.carry(link);
  void switchProfile(profile.id);
}

function subscribe() {
  ui.subscribeUrl = ui.sharedLink?.url ?? null;
  ui.sharedLink = null;
  ui.subscribeOpen = true;
}

function publish() {
  const link = ui.sharedLink;
  ui.sharedLink = null;
  if (!link) return;
  ui.publishDraft = { url: link.url, title: link.title };
  ui.publishOpen = true;
}
</script>

<template>
  <v-dialog v-model="open" max-width="520" @after-leave="restoreFocus">
    <v-card :title="t('sharedLink.title')">
      <v-card-text>
        <p v-if="ui.sharedLink?.title" class="text-body-large">{{ ui.sharedLink.title }}</p>
        <p class="text-body-medium text-medium-emphasis text-break">{{ ui.sharedLink?.url }}</p>
        <div v-if="target && others.length > 0" class="d-flex align-center flex-wrap ga-2 mt-4">
          <ProfileAvatar :profile="target" :size="24" />
          <span class="text-body-medium">
            {{ t('sharedLink.to', { profile: profileLabel(target) }) }}
          </span>
          <v-menu>
            <template #activator="{ props: menu }">
              <v-btn variant="text" size="small" :append-icon="mdiMenuDown" v-bind="menu">
                {{ t('sharedLink.switch') }}
              </v-btn>
            </template>
            <v-list density="compact">
              <v-list-item
                v-for="profile in others"
                :key="profile.id"
                :title="profileLabel(profile)"
                @click="moveTo(profile)"
              >
                <template #prepend>
                  <ProfileAvatar :profile="profile" :size="24" class="me-3" />
                </template>
              </v-list-item>
            </v-list>
          </v-menu>
        </div>
      </v-card-text>
      <v-card-actions class="flex-wrap">
        <v-btn @click="open = false">{{ t('common.cancel') }}</v-btn>
        <v-spacer />
        <v-btn variant="tonal" @click="subscribe">{{ t('sharedLink.subscribe') }}</v-btn>
        <v-btn color="primary" variant="flat" @click="publish">
          {{ t('sharedLink.publish') }}
        </v-btn>
      </v-card-actions>
    </v-card>
  </v-dialog>
</template>
