import { onBeforeUnmount, shallowRef, watch } from 'vue';
import { currentStore } from '../offline/store.ts';

/**
 * The images of an entry stored on the device, as `blob:` URLs by their original URL. The URLs
 * are released when the entry changes or the component goes.
 */
export function useStoredImages(entryId: () => number) {
  const images = shallowRef<ReadonlyMap<string, string>>(new Map());
  let made: string[] = [];
  const release = () => {
    for (const url of made) URL.revokeObjectURL(url);
    made = [];
  };
  watch(
    entryId,
    async (id) => {
      release();
      images.value = new Map();
      const db = currentStore();
      if (!db) return;
      const stored = await db.images
        .where('entryIds')
        .equals(id)
        .toArray()
        .catch(() => []);
      if (entryId() !== id || stored.length === 0) return;
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
  onBeforeUnmount(release);
  return images;
}
