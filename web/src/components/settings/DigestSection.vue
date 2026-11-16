<script setup lang="ts">
import type { DigestFrequency } from '@newses/shared';
import { localTimeZone } from '@newses/shared/client';
import { useQuery } from '@tanstack/vue-query';
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { api } from '../../api.ts';
import { usePrefs } from '../../composables/usePrefs.ts';
import { useSession } from '../../composables/useSession.ts';

const { t, locale } = useI18n();
const { prefs, update } = usePrefs();
const { session } = useSession();

/** Shown where the server emails digests (API 1.14): mail, and its public URL for their links. */
const serverInfo = useQuery({
  queryKey: ['server-info'],
  queryFn: () => api.serverInfo(),
  staleTime: Infinity,
});
const shown = computed(() => serverInfo.data.value?.digest === true);
/** Digests go to the confirmed address only. */
const ready = computed(() => !!session.value?.user.email);

const frequencies = computed(() =>
  (['off', 'daily', 'weekly'] as const).map((value) => ({
    value,
    title: t(`email.digest.${value}`),
  })),
);

/** Monday first; 4 January 2026 was a Sunday. */
const weekdays = computed(() => {
  const format = new Intl.DateTimeFormat(locale.value, { weekday: 'long', timeZone: 'UTC' });
  return [1, 2, 3, 4, 5, 6, 0].map((value) => ({
    value,
    title: format.format(Date.UTC(2026, 0, 4 + value)),
  }));
});

const hours = computed(() => {
  const format = new Intl.DateTimeFormat(locale.value, {
    hour: 'numeric',
    minute: '2-digit',
    timeZone: 'UTC',
  });
  return Array.from({ length: 24 }, (_, value) => ({
    value,
    title: format.format(Date.UTC(2026, 0, 1, value)),
  }));
});

/** Every zone the browser knows, with the reader's and UTC even where it lists neither. */
const zones = computed(() => {
  const known =
    typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : [];
  return [...new Set([...known, localTimeZone(), 'UTC', prefs.value.timeZone ?? 'UTC'])].sort();
});

/** Turning digests on takes the device's time zone when none is set. */
function setFrequency(value: DigestFrequency) {
  update({
    digestFrequency: value,
    ...(value !== 'off' && prefs.value.timeZone === null && { timeZone: localTimeZone() }),
  });
}
</script>

<template>
  <section v-if="shown" class="mb-6">
    <h3 class="text-title-medium mb-2">{{ t('email.digest.heading') }}</h3>
    <p class="text-body-medium text-medium-emphasis mb-3">
      {{ ready ? t('email.digest.hint') : t('email.digest.needsAddress') }}
    </p>
    <v-row dense>
      <v-col cols="12" sm="6">
        <v-select
          :model-value="prefs.digestFrequency"
          :items="frequencies"
          :label="t('email.digest.frequency')"
          :disabled="!ready"
          @update:model-value="setFrequency"
        />
      </v-col>
      <v-col v-if="prefs.digestFrequency === 'weekly'" cols="12" sm="6">
        <v-select
          :model-value="prefs.digestWeekday"
          :items="weekdays"
          :label="t('email.digest.day')"
          :disabled="!ready"
          @update:model-value="(v: number) => update({ digestWeekday: v })"
        />
      </v-col>
      <template v-if="prefs.digestFrequency !== 'off'">
        <v-col cols="12" sm="6">
          <v-select
            :model-value="prefs.digestHour"
            :items="hours"
            :label="t('email.digest.time')"
            :disabled="!ready"
            @update:model-value="(v: number) => update({ digestHour: v })"
          />
        </v-col>
        <v-col cols="12" sm="6">
          <v-autocomplete
            :model-value="prefs.timeZone ?? 'UTC'"
            :items="zones"
            :label="t('email.digest.timeZone')"
            :disabled="!ready"
            dir="ltr"
            auto-select-first
            @update:model-value="(v: string | null) => v && update({ timeZone: v })"
          />
        </v-col>
        <v-col cols="12">
          <v-switch
            :model-value="prefs.digestMarkRead"
            :label="t('email.digest.markRead')"
            :disabled="!ready"
            color="primary"
            hide-details
            @update:model-value="(v) => update({ digestMarkRead: Boolean(v) })"
          />
        </v-col>
      </template>
    </v-row>
  </section>
</template>
