<script setup lang="ts">
import { watchEffect } from 'vue';
import { useI18n } from 'vue-i18n';
import { useRouter } from 'vue-router';
import { useTheme } from 'vuetify';
import ConfirmDialog from '../components/dialogs/ConfirmDialog.vue';
import EditFeedDialog from '../components/dialogs/EditFeedDialog.vue';
import EntryLabelsDialog from '../components/dialogs/EntryLabelsDialog.vue';
import NoteDialog from '../components/dialogs/NoteDialog.vue';
import ShareDialog from '../components/dialogs/ShareDialog.vue';
import ShortcutHelp from '../components/dialogs/ShortcutHelp.vue';
import TagPickerDialog from '../components/dialogs/TagPickerDialog.vue';
import TagsDialog from '../components/dialogs/TagsDialog.vue';
import SubscribeDialog from '../components/dialogs/SubscribeDialog.vue';
import FeedTree from '../components/reader/FeedTree.vue';
import { useLiveCounters } from '../composables/useCounters.ts';
import { usePrefs } from '../composables/usePrefs.ts';
import { useShortcutListener } from '../composables/useShortcuts.ts';
import type { ShortcutAction } from '../lib/shortcuts.ts';
import { useUiStore } from '../stores/ui.ts';

const { t } = useI18n();
const ui = useUiStore();
const router = useRouter();
const theme = useTheme();
const { prefs, loaded, update } = usePrefs();

watchEffect(() => {
  if (loaded.value) theme.change(prefs.value.theme);
});

useLiveCounters();

function skipToMain() {
  document.getElementById('main')?.focus();
}

const GOTO: Partial<Record<ShortcutAction, string>> = {
  gotoAll: '/all',
  gotoFresh: '/fresh',
  gotoStarred: '/starred',
  gotoPublished: '/published',
  gotoRecentlyRead: '/read',
  gotoSettings: '/settings',
};

useShortcutListener((action) => {
  const target = GOTO[action];
  if (target) {
    void router.push(target);
    return true;
  }
  switch (action) {
    case 'help':
      ui.helpOpen = true;
      return true;
    case 'subscribe':
      ui.subscribeOpen = true;
      return true;
    case 'gotoTags':
      ui.tagPickerOpen = true;
      return true;
    case 'toggleHideRead':
      update({ hideReadFeeds: !prefs.value.hideReadFeeds });
      return true;
    default:
      return false;
  }
});
</script>

<template>
  <a href="#main" class="skip-link" @click.prevent="skipToMain">{{ t('nav.skipToContent') }}</a>
  <v-navigation-drawer v-model="ui.drawer" width="300">
    <FeedTree />
  </v-navigation-drawer>
  <router-view />
  <SubscribeDialog />
  <EditFeedDialog />
  <NoteDialog />
  <EntryLabelsDialog />
  <TagsDialog />
  <TagPickerDialog />
  <ShareDialog />
  <ShortcutHelp />
  <ConfirmDialog />
</template>
