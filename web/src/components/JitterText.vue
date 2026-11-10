<script setup lang="ts">
import { computed } from 'vue';
import { appliedTokens } from '../composables/useAppearance.ts';
import { jitterLetters } from '../lib/jitter.ts';

const props = defineProps<{ text: string }>();

/** The Noir style's typewriter lettering, a texture; screen readers get the text as it is. */
const parts = computed(() => {
  const { style, effects } = appliedTokens.value;
  return style === 'noir' && effects.texture ? jitterLetters(props.text) : null;
});
/** Letters strike in turn, up to this many apart. */
const MAX_DELAY_STEPS = 24;
</script>

<template>
  <span v-if="parts"
    ><span class="d-sr-only">{{ text }}</span
    ><span :key="text" class="jitter" aria-hidden="true"
      ><template v-for="(part, i) in parts" :key="i"
        ><template v-if="typeof part === 'string'">{{ part }}</template
        ><span v-else class="jitter-word"
          ><span
            v-for="letter in part"
            :key="letter.index"
            class="jitter-letter"
            :style="{
              '--jy': `${letter.y}em`,
              '--jr': `${letter.rotate}deg`,
              '--ji': Math.min(letter.index, MAX_DELAY_STEPS),
            }"
            >{{ letter.text }}</span
          ></span
        ></template
      ></span
    ></span
  >
  <template v-else>{{ text }}</template>
</template>

<style scoped>
/* Selecting and copying take the readable copy. */
.jitter {
  user-select: none;
}
/* A word breaks between lines whole, never between its letters. */
.jitter-word {
  white-space: nowrap;
}
/* Each letter keeps its advance, so a monospaced font keeps them on the grid. */
.jitter-letter {
  display: inline-block;
  transform: translateY(var(--jy)) rotate(var(--jr));
}
</style>
