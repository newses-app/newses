<script setup lang="ts">
import { useI18n } from 'vue-i18n';
import { formatDateTime, formatRelative } from '../../lib/format.ts';

/** A feed's last error with when it happened: relative in the text, absolute on hover. */
defineProps<{ error: string; at: string | null; disabled?: boolean }>();

const { t, locale } = useI18n();
</script>

<template>
  <i18n-t v-if="at" :keypath="disabled ? 'feeds.disabledAt' : 'feeds.errorAt'" tag="span">
    <template #when>
      <time :datetime="at" :title="formatDateTime(at, locale)">{{
        formatRelative(at, locale)
      }}</time>
    </template>
    <template #error>{{ error }}</template>
  </i18n-t>
  <span v-else>{{ disabled ? t('feeds.disabled', { error }) : error }}</span>
</template>
