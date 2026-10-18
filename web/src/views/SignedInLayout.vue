<script setup lang="ts">
import { watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { useRouter } from 'vue-router';
import ConfirmDialog from '../components/dialogs/ConfirmDialog.vue';
import EditFeedDialog from '../components/dialogs/EditFeedDialog.vue';
import EntryLabelsDialog from '../components/dialogs/EntryLabelsDialog.vue';
import NoteConflictDialog from '../components/dialogs/NoteConflictDialog.vue';
import NoteDialog from '../components/dialogs/NoteDialog.vue';
import PublishDialog from '../components/dialogs/PublishDialog.vue';
import ScoreDialog from '../components/dialogs/ScoreDialog.vue';
import ShareDialog from '../components/dialogs/ShareDialog.vue';
import ShortcutHelp from '../components/dialogs/ShortcutHelp.vue';
import TagPickerDialog from '../components/dialogs/TagPickerDialog.vue';
import TagsDialog from '../components/dialogs/TagsDialog.vue';
import SubscribeDialog from '../components/dialogs/SubscribeDialog.vue';
import OfflineStatus from '../components/OfflineStatus.vue';
import FeedTree from '../components/reader/FeedTree.vue';
import { useAppearance } from '../composables/useAppearance.ts';
import { useLiveCounters } from '../composables/useCounters.ts';
import { useEntryNotifications } from '../composables/useEntryNotifications.ts';
import { useOfflineSync } from '../composables/useOfflineSync.ts';
import { usePrefs } from '../composables/usePrefs.ts';
import { useShortcutListener } from '../composables/useShortcuts.ts';
import { shares } from '../platform/index.ts';
import type { ShortcutAction } from '../lib/shortcuts.ts';
import { useUiStore } from '../stores/ui.ts';

const { t } = useI18n();
const ui = useUiStore();
const router = useRouter();
const { prefs, update } = usePrefs();

useAppearance();

useLiveCounters();
useEntryNotifications();
useOfflineSync();

// A URL shared to the app, now or before signing in, opens the subscribe dialog filled in.
watch(
  shares.pending,
  (url) => {
    if (!url) return;
    ui.subscribeUrl = shares.take();
    ui.subscribeOpen = true;
  },
  { immediate: true },
);

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
  <PublishDialog />
  <EditFeedDialog />
  <NoteDialog />
  <ScoreDialog />
  <EntryLabelsDialog />
  <TagsDialog />
  <TagPickerDialog />
  <ShareDialog />
  <ShortcutHelp />
  <NoteConflictDialog />
  <ConfirmDialog />
  <OfflineStatus />
</template>
