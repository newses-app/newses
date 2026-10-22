import { onBeforeUnmount, ref, shallowRef, watch } from 'vue';
import { currentStore } from '../offline/store.ts';

/** How long the content waits for the lookup, as when a sync keeps the store busy. */
export const LOOKUP_WAIT_MS = 1500;

/**
 * The images of an entry stored on the device, as `blob:` URLs by their original URL, and whether
 * they have been looked up yet, or the lookup has taken too long to wait for: the URLs found later
 * still replace the others. The URLs are released when the entry changes or the component goes.
 */
export function useStoredImages(entryId: () => number) {
  const images = shallowRef<ReadonlyMap<string, string>>(new Map());
  const ready = ref(false);
  let made: string[] = [];
  let waiting: ReturnType<typeof setTimeout> | undefined;
  const release = () => {
    for (const url of made) URL.revokeObjectURL(url);
    made = [];
  };
  watch(
    entryId,
    async (id) => {
      release();
      clearTimeout(waiting);
      images.value = new Map();
      const db = currentStore();
      ready.value = !db;
      if (!db) return;
      waiting = setTimeout(() => {
        ready.value = true;
      }, LOOKUP_WAIT_MS);
      const stored = await db.images
        .where('entryIds')
        .equals(id)
        .toArray()
        .catch(() => []);
      if (entryId() !== id) return;
      clearTimeout(waiting);
      ready.value = true;
      if (stored.length === 0) return;
      const urls = new Map<string, string>();
      for (const image of stored) {
        const url = URL.createObjectURL(image.blob);
        made.push(url);
        urls.set(image.url, url);
      }
      images.value = urls;
    },
    { immediate: true },
  );
  onBeforeUnmount(() => {
    clearTimeout(waiting);
    release();
  });
  return { images, ready };
}
