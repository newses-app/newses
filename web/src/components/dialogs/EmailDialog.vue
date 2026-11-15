<script setup lang="ts">
import type { ShareLink } from '@newses/shared';
import {
  MAX_EMAIL_LENGTH,
  MAX_EMAIL_NOTE_LENGTH,
  MAX_EMAIL_RECIPIENTS,
  MAX_SHARE_TITLE_LENGTH,
} from '@newses/shared/client';
import { useQuery } from '@tanstack/vue-query';
import { computed, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { api } from '../../api.ts';
import { useErrorText } from '../../composables/useErrorText.ts';
import { useReturnFocus } from '../../composables/useReturnFocus.ts';
import { useSession } from '../../composables/useSession.ts';
import { safeUrl } from '../../lib/format.ts';
import { withoutIsolates } from '../../lib/message-params.ts';
import { shareUrl } from '../../lib/sharing.ts';
import { bridge } from '../../platform/index.ts';
import { useUiStore } from '../../stores/ui.ts';

const ui = useUiStore();
const { t } = useI18n();
const errorText = useErrorText();
const { session } = useSession();

const open = computed({
  get: () => ui.emailEntry !== null,
  set: (value) => {
    if (!value) ui.emailEntry = null;
  },
});
const restoreFocus = useReturnFocus(() => open.value);

/** The server mails users from API 1.14, when its operator configured mail. */
const serverInfo = useQuery({
  queryKey: ['server-info'],
  queryFn: () => api.serverInfo(),
  staleTime: Infinity,
});
const mail = computed(() => serverInfo.data.value?.mail === true);
const replyTo = computed(() => session.value?.user.email ?? null);
const hasLink = computed(() => safeUrl(ui.emailEntry?.link) !== null);

/** Mailed by the server, or handed to the device's share sheet or mail app. */
type Via = 'server' | 'device';
const VIA_KEY = 'newses.emailVia';

/** The way last chosen on this device. */
function storedVia(): Via | null {
  try {
    const value = localStorage.getItem(VIA_KEY);
    return value === 'server' || value === 'device' ? value : null;
  } catch {
    return null;
  }
}

const via = ref<Via>('device');
/** Only the device where the server mails no one. */
const shownVia = computed<Via>(() => (mail.value ? via.value : 'device'));

function choose(value: unknown) {
  if (value !== 'server' && value !== 'device') return;
  via.value = value;
  try {
    localStorage.setItem(VIA_KEY, value);
  } catch {
    // Storage blocked: the choice lasts until the dialog opens again.
  }
}

/** The original's address, with the public share link's when it has one; null without either. */
const deviceLink = computed((): ShareLink | null => {
  const entry = ui.emailEntry;
  if (!entry) return null;
  const original = safeUrl(entry.link);
  const copy = entry.shareId ? shareUrl(entry.shareId) : null;
  const url = original ?? copy;
  if (!url) return null;
  return {
    title: (entry.title ?? t('entries.untitled')).slice(0, MAX_SHARE_TITLE_LENGTH),
    text: original && copy ? withoutIsolates(t('email.sharedCopy', { url: copy })) : '',
    url,
  };
});

const recipients = ref<string[]>([]);
const typed = ref('');
const note = ref('');
const include = ref<'content' | 'link'>('content');
const busy = ref(false);

watch(
  () => ui.emailEntry,
  (entry) => {
    if (!entry) return;
    recipients.value = [];
    typed.value = '';
    note.value = '';
    include.value = 'content';
    via.value = storedVia() ?? (replyTo.value ? 'server' : 'device');
  },
);

const ADDRESS = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/** Addresses entered, with one still being typed, each once. */
function addresses(): string[] {
  const all = [...recipients.value, ...typed.value.split(/[,;\s]+/)]
    .map((address) => address.trim())
    .filter(Boolean);
  return all.filter(
    (address, index) =>
      all.findIndex((other) => other.toLowerCase() === address.toLowerCase()) === index,
  );
}

const invalid = computed(() => addresses().filter((address) => !ADDRESS.test(address)));
const tooMany = computed(() => addresses().length > MAX_EMAIL_RECIPIENTS);
const recipientError = computed(() => {
  if (invalid.value.length > 0)
    return t('email.invalidAddress', { address: invalid.value[0] ?? '' });
  if (tooMany.value) return t('email.tooManyRecipients', { n: MAX_EMAIL_RECIPIENTS });
  return null;
});

/** Called straight from the click, which the share sheet needs. */
async function shareFromDevice() {
  const link = deviceLink.value;
  if (!link) return;
  try {
    if (await bridge.shareLink(link)) open.value = false;
  } catch (error) {
    ui.notify(errorText(error), true);
  }
}

async function send() {
  const entry = ui.emailEntry;
  const to = addresses();
  if (!entry || to.length === 0 || recipientError.value) return;
  busy.value = true;
  try {
    await api.entries.email(entry.id, {
      to,
      include: hasLink.value ? include.value : 'content',
      ...(note.value.trim() && { note: note.value.trim() }),
    });
    open.value = false;
    ui.notify(t('email.articleSent', { n: to.length }, to.length));
  } catch (error) {
    ui.notify(errorText(error), true);
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <v-dialog v-model="open" max-width="560" @after-leave="restoreFocus">
    <v-card
      v-if="ui.emailEntry"
      :title="t('email.articleTitle')"
      :subtitle="ui.emailEntry.title ?? t('entries.untitled')"
    >
      <v-tabs v-if="mail" :model-value="shownVia" grow class="mb-2" @update:model-value="choose">
        <v-tab value="server">{{ t('email.viaServer') }}</v-tab>
        <v-tab value="device">{{ t('email.viaDevice') }}</v-tab>
      </v-tabs>
      <template v-if="shownVia === 'device'">
        <v-card-text>
          <p class="text-body-medium">
            {{ deviceLink ? t('email.deviceHint') : t('email.deviceNeedsLink') }}
          </p>
        </v-card-text>
        <v-card-actions>
          <v-spacer />
          <v-btn @click="open = false">{{ t('common.cancel') }}</v-btn>
          <v-btn color="primary" variant="flat" :disabled="!deviceLink" @click="shareFromDevice">
            {{ t('email.shareFromDevice') }}
          </v-btn>
        </v-card-actions>
      </template>
      <template v-else-if="!replyTo">
        <v-card-text>
          <p class="text-body-medium">{{ t('email.needsAddress') }}</p>
        </v-card-text>
        <v-card-actions>
          <v-spacer />
          <v-btn @click="open = false">{{ t('common.close') }}</v-btn>
          <v-btn color="primary" variant="flat" to="/settings/account" @click="open = false">
            {{ t('email.openAccount') }}
          </v-btn>
        </v-card-actions>
      </template>
      <v-form v-else @submit.prevent="send">
        <v-card-text>
          <v-combobox
            v-model="recipients"
            v-model:search="typed"
            :label="t('email.recipients')"
            :hint="t('email.recipientsHint', { n: MAX_EMAIL_RECIPIENTS })"
            persistent-hint
            :error-messages="recipientError"
            :delimiters="[',', ';', ' ']"
            :maxlength="MAX_EMAIL_LENGTH"
            type="email"
            dir="ltr"
            autocomplete="email"
            multiple
            chips
            closable-chips
            hide-no-data
            autofocus
            class="mb-2"
          />
          <v-textarea
            v-model="note"
            :label="t('email.note')"
            dir="auto"
            rows="3"
            auto-grow
            counter
            :maxlength="MAX_EMAIL_NOTE_LENGTH"
          />
          <v-radio-group v-if="hasLink" v-model="include" :label="t('email.include')" hide-details>
            <v-radio value="content" :label="t('email.includeContent')" />
            <v-radio value="link" :label="t('email.includeLink')" />
          </v-radio-group>
          <p class="text-body-small text-medium-emphasis mt-3">
            {{ t('email.replyHint', { email: replyTo }) }}
          </p>
        </v-card-text>
        <v-card-actions>
          <v-spacer />
          <v-btn @click="open = false">{{ t('common.cancel') }}</v-btn>
          <v-btn
            type="submit"
            color="primary"
            variant="flat"
            :loading="busy"
            :disabled="addresses().length === 0 || recipientError !== null"
          >
            {{ t('email.sendArticle') }}
          </v-btn>
        </v-card-actions>
      </v-form>
    </v-card>
  </v-dialog>
</template>
