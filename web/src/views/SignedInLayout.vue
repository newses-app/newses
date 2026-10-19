<script setup lang="ts">
import { watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { useRouter } from 'vue-router';
import { api } from '../api.ts';
import ConfirmDialog from '../components/dialogs/ConfirmDialog.vue';
import EditFeedDialog from '../components/dialogs/EditFeedDialog.vue';
import EntryLabelsDialog from '../components/dialogs/EntryLabelsDialog.vue';
import FeedDebugDialog from '../components/dialogs/FeedDebugDialog.vue';
import NoteConflictDialog from '../components/dialogs/NoteConflictDialog.vue';
import NoteDialog from '../components/dialogs/NoteDialog.vue';
import PublishDialog from '../components/dialogs/PublishDialog.vue';
import ScoreDialog from '../components/dialogs/ScoreDialog.vue';
import ShareDialog from '../components/dialogs/ShareDialog.vue';
import SharedLinkDialog from '../components/dialogs/SharedLinkDialog.vue';
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
import { supportsPublishing } from '../lib/server-url.ts';
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

// A page shared to the app, now or before signing in, is offered to subscribe to or publish;
// servers that cannot publish pages open the subscribe dialog filled in.
watch(
  shares.pending,
  async (pending) => {
    if (!pending) return;
    const link = shares.take();
    if (!link) return;
    const publishing = await api.serverInfo().then(supportsPublishing, () => true);
    if (publishing) {
      ui.sharedLink = link;
      return;
    }
    ui.subscribeUrl = link.url;
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
  <SharedLinkDialog />
  <EditFeedDialog />
  <FeedDebugDialog />
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
