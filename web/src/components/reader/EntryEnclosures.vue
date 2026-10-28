<script setup lang="ts">
import type { Enclosure } from '@newses/shared';
import { mdiPaperclip } from '@mdi/js';
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { type EnclosureView, enclosureViews } from '../../lib/enclosures.ts';
import { formatDuration, formatStorage } from '../../lib/format.ts';
import { connectivity } from '../../offline/connectivity.ts';
import { appServer } from '../../platform/index.ts';

const props = defineProps<{
  enclosures: readonly Enclosure[];
  /** The article HTML as stored, so media it already shows is not shown twice. */
  content: string | null | undefined;
  /** Images stored on the device, by original URL. */
  stored?: ReadonlyMap<string, string> | undefined;
}>();
const { t, locale } = useI18n();

const probe = typeof document === 'undefined' ? null : document.createElement('video');
const views = computed(() =>
  enclosureViews(props.enclosures, {
    content: props.content,
    stored: props.stored ?? new Map(),
    online: connectivity.value === 'online',
    server: appServer(),
    canPlay: (type) => probe?.canPlayType(type) !== '',
  }),
);
const players = computed(() => views.value.filter((view) => view.player));
const images = computed(() => views.value.filter((view) => view.imageSrc));
// Images open from the gallery; everything else keeps a link, players included, to download.
const links = computed(() => views.value.filter((view) => view.kind !== 'image' || !view.imageSrc));

function details({ enclosure }: EnclosureView): string {
  const parts = [
    enclosure.mimeType,
    enclosure.durationSeconds ? formatDuration(enclosure.durationSeconds) : null,
    enclosure.length ? formatStorage(enclosure.length, locale.value) : null,
  ].filter((part): part is string => !!part);
  return new Intl.ListFormat(locale.value, { style: 'short', type: 'unit' }).format(parts);
}

const aspectRatio = ({ enclosure }: EnclosureView) =>
  enclosure.width && enclosure.height
    ? `${String(enclosure.width)} / ${String(enclosure.height)}`
    : '16 / 9';
</script>

<template>
  <div v-if="views.length" class="entry-enclosures mt-4">
    <!-- Nothing reaches the media host until the reader presses play. -->
    <figure v-for="view in players" :key="view.enclosure.url" class="enclosure-player mb-3">
      <audio
        v-if="view.kind === 'audio'"
        :src="view.enclosure.url"
        controls
        preload="none"
        class="enclosure-media"
      />
      <video
        v-else
        :src="view.enclosure.url"
        controls
        preload="none"
        playsinline
        class="enclosure-media"
        :style="{ aspectRatio: aspectRatio(view) }"
      />
      <figcaption class="text-body-small text-medium-emphasis">
        {{ view.name }}<span v-if="details(view)"> · {{ details(view) }}</span>
      </figcaption>
    </figure>
    <ul v-if="images.length" class="enclosure-gallery mb-3">
      <li v-for="(view, index) in images" :key="view.enclosure.url">
        <a :href="view.enclosure.url" target="_blank" rel="noopener noreferrer">
          <img
            :src="view.imageSrc ?? undefined"
            :alt="t('entries.attachedImage', { n: index + 1 })"
            :width="view.enclosure.width ?? undefined"
            :height="view.enclosure.height ?? undefined"
            loading="lazy"
            decoding="async"
          />
        </a>
      </li>
    </ul>
    <v-list v-if="links.length" density="compact">
      <v-list-subheader>{{ t('entries.attachments') }}</v-list-subheader>
      <!-- Vuetify gives link items role=link, so each sits in its own listitem. -->
      <div v-for="view in links" :key="view.enclosure.url" role="listitem">
        <v-list-item
          :href="view.enclosure.url"
          target="_blank"
          rel="noopener noreferrer"
          :prepend-icon="mdiPaperclip"
          :title="view.name"
          :subtitle="details(view)"
        />
      </div>
    </v-list>
  </div>
</template>

<style scoped>
.enclosure-player {
  margin-inline: 0;
}
.enclosure-media {
  display: block;
  width: 100%;
  max-width: 100%;
}
video.enclosure-media {
  height: auto;
  background: #000;
}
.enclosure-gallery {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(10rem, 1fr));
  gap: 0.5rem;
  padding: 0;
  list-style: none;
}
.enclosure-gallery a {
  display: block;
  border-radius: 4px;
  overflow: hidden;
}
.enclosure-gallery img {
  display: block;
  width: 100%;
  height: 10rem;
  object-fit: cover;
}
</style>
