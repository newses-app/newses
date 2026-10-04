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
    notice,
    confirmRequest,
    notify,
    confirm,
  };
});
