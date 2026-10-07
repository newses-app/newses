import type { Entry } from '@rss-reader/shared';
import { defineStore } from 'pinia';
import { ref } from 'vue';

export interface ConfirmRequest {
  title: string;
  text: string;
  action: string;
  resolve: (confirmed: boolean) => void;
}

/** Cross-component UI state: drawer, dialogs, notices. */
export const useUiStore = defineStore('ui', () => {
  /** Null lets the drawer follow the screen size. */
  const drawer = ref<boolean | null>(null);
  const helpOpen = ref(false);
  const subscribeOpen = ref(false);
  const editSubscriptionId = ref<number | null>(null);
  /** The entry whose note is being edited. */
  const noteEntry = ref<Entry | null>(null);
  /** The entry whose labels are being chosen. */
  const labelsEntry = ref<Entry | null>(null);
  /** The entry whose tags are being edited. */
  const tagsEntry = ref<Entry | null>(null);
  const tagPickerOpen = ref(false);
  /** The entry whose share link is shown. */
  const shareEntry = ref<Entry | null>(null);
  const notice = ref<{ text: string; error: boolean } | null>(null);
  const confirmRequest = ref<ConfirmRequest | null>(null);

  function notify(text: string, error = false) {
    notice.value = { text, error };
  }

  function confirm(title: string, text: string, action: string): Promise<boolean> {
    confirmRequest.value?.resolve(false);
    return new Promise((resolve) => {
      confirmRequest.value = {
        title,
        text,
        action,
        resolve: (confirmed) => {
          confirmRequest.value = null;
          resolve(confirmed);
        },
      };
    });
  }

  return {
    drawer,
    helpOpen,
    subscribeOpen,
    editSubscriptionId,
    noteEntry,
    labelsEntry,
    tagsEntry,
    tagPickerOpen,
    shareEntry,
    notice,
    confirmRequest,
    notify,
    confirm,
  };
});
