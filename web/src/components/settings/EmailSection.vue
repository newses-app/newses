<script setup lang="ts">
import { mdiDelete, mdiEmailFastOutline } from '@mdi/js';
import type { CurrentSession, User } from '@newses/shared';
import { MAX_EMAIL_LENGTH } from '@newses/shared/client';
import { useQuery, useQueryClient } from '@tanstack/vue-query';
import { computed, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { api } from '../../api.ts';
import { useErrorText } from '../../composables/useErrorText.ts';
import { SESSION_KEY, useSession } from '../../composables/useSession.ts';
import { useUiStore } from '../../stores/ui.ts';
import DigestSection from './DigestSection.vue';

const { t } = useI18n();
const errorText = useErrorText();
const ui = useUiStore();
const queryClient = useQueryClient();
const { session } = useSession();

/** Shown where the server can email users (API 1.14). */
const serverInfo = useQuery({
  queryKey: ['server-info'],
  queryFn: () => api.serverInfo(),
  staleTime: Infinity,
});
const shown = computed(() => serverInfo.data.value?.mail === true);
const email = computed(() => session.value?.user.email ?? null);
const pending = computed(() => session.value?.user.pendingEmail ?? null);

const address = ref('');
const busy = ref(false);

function setUser(changes: Partial<User>) {
  queryClient.setQueryData<CurrentSession>(
    SESSION_KEY,
    (current) => current && { ...current, user: { ...current.user, ...changes } },
  );
}

async function run(work: () => Promise<void>) {
  busy.value = true;
  try {
    await work();
  } catch (err) {
    ui.notify(errorText(err), true);
  } finally {
    busy.value = false;
  }
}

/** Mails a confirmation link; the address waits, pending, until it is followed. */
const send = (to: string) =>
  run(async () => {
    const user = await api.account.setEmail(to);
    setUser({ email: user.email ?? null, pendingEmail: user.pendingEmail ?? null });
    address.value = '';
    if (user.pendingEmail) ui.notify(t('email.sent', { email: user.pendingEmail }));
  });

/** Drops the pending address, keeping a confirmed one: asking for that one mails nothing. */
const cancel = () =>
  email.value
    ? send(email.value)
    : run(async () => {
        await api.account.removeEmail();
        setUser({ pendingEmail: null });
      });

async function remove() {
  const current = email.value;
  if (!current) return;
  const confirmed = await ui.confirm(
    t('email.removeTitle', { email: current }),
    t('email.removeText'),
    t('email.remove'),
  );
  if (!confirmed) return;
  await run(async () => {
    await api.account.removeEmail();
    setUser({ email: null, pendingEmail: null });
  });
}
</script>

<template>
  <template v-if="shown">
    <h2 class="text-title-large mb-2">{{ t('email.heading') }}</h2>
    <p class="text-body-medium text-medium-emphasis mb-2">{{ t('email.hint') }}</p>
    <v-list v-if="email || pending" density="compact" class="mb-2">
      <v-list-item v-if="email" :subtitle="t('email.confirmed')">
        <template #title
          ><span dir="ltr">{{ email }}</span></template
        >
        <template #append>
          <v-btn
            :icon="mdiDelete"
            variant="text"
            size="small"
            :disabled="busy"
            :aria-label="t('email.removeNamed', { email })"
            @click="remove"
          />
        </template>
      </v-list-item>
      <v-list-item v-if="pending" :subtitle="t('email.unconfirmed')">
        <template #title
          ><span dir="ltr">{{ pending }}</span></template
        >
        <template #append>
          <v-btn
            :icon="mdiEmailFastOutline"
            variant="text"
            size="small"
            :disabled="busy"
            :aria-label="t('email.sendLinkNamed', { email: pending })"
            @click="send(pending)"
          />
          <v-btn size="small" variant="text" :disabled="busy" @click="cancel">
            {{ t('common.cancel') }}
          </v-btn>
        </template>
      </v-list-item>
    </v-list>
    <v-form class="d-flex flex-wrap align-start ga-2 mb-6" @submit.prevent="send(address)">
      <v-text-field
        v-model="address"
        type="email"
        :label="email ? t('email.newAddress') : t('email.address')"
        dir="ltr"
        autocomplete="email"
        spellcheck="false"
        :maxlength="MAX_EMAIL_LENGTH"
        density="compact"
        hide-details
        class="email-field"
      />
      <v-btn type="submit" variant="tonal" :loading="busy" :disabled="!address.trim()">
        {{ t('email.send') }}
      </v-btn>
    </v-form>
    <DigestSection />
  </template>
</template>

<style scoped>
.email-field {
  flex: 1 1 16rem;
  max-inline-size: 24rem;
}
</style>
