<script setup lang="ts">
import { useI18n } from 'vue-i18n';

defineProps<{ n: number }>();
const { t } = useI18n();
</script>

<template>
  <span class="unread-count text-label-medium">
    <span aria-hidden="true">{{ n }}</span
    >{{ ' ' }}<span class="d-sr-only">{{ t('tree.unread', { n }) }}</span>
  </span>
</template>
