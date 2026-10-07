<script setup lang="ts">
import { mdiTrendingDown, mdiTrendingUp } from '@mdi/js';
import { useI18n } from 'vue-i18n';

defineProps<{ score: number; high: boolean }>();
const { t, n } = useI18n();
</script>

<template>
  <span v-if="score !== 0" class="score" :class="{ high }">
    <v-icon :icon="score > 0 ? mdiTrendingUp : mdiTrendingDown" size="14" aria-hidden="true" />
    <span class="d-sr-only">{{ high ? t('entries.highScore') : t('entries.score') }}</span>
    {{ n(score) }}
  </span>
</template>

<style scoped>
.score {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  font-size: 0.75rem;
  font-weight: 500;
  white-space: nowrap;
}
.score.high {
  color: rgb(var(--v-theme-primary));
  font-weight: 700;
}
</style>
