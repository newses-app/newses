import { onBeforeUnmount, type Ref, watch } from 'vue';
import { anchoredScrollTop, capturePosition, type ListPosition } from '../lib/list-position.ts';

interface Options {
  /** The rows' data attribute holding their key, as in `data-entry`. */
  attr: string;
  count: () => number;
  /** The place to scroll back to when the list mounts. */
  position: () => ListPosition | null;
  /** The row of the article the reader came back from, shown and focused once restored. */
  returnedFrom: () => string | null;
  save: (position: ListPosition) => void;
}

/**
 * Keeps a list's place while it is unmounted, as on phones while an article is open: saved as it
 * goes, restored once it is back and has rows.
 */
export function useListPosition(scroller: Ref<HTMLElement | null>, options: Options): void {
  const { attr } = options;
  const row = (element: HTMLElement, key: string) =>
    element.querySelector<HTMLElement>(`[data-${attr}="${CSS.escape(key)}"]`);

  function* boxes(element: HTMLElement) {
    for (const row of element.querySelectorAll<HTMLElement>(`[data-${attr}]`)) {
      const { top, bottom } = row.getBoundingClientRect();
      yield { key: row.getAttribute(`data-${attr}`) ?? '', top, bottom };
    }
  }

  onBeforeUnmount(() => {
    const element = scroller.value;
    if (!element) return;
    const viewTop = element.getBoundingClientRect().top;
    options.save(capturePosition(boxes(element), viewTop, element.scrollTop));
  });

  const stop = watch(
    () => scroller.value !== null && options.count() > 0,
    (ready) => {
      const element = scroller.value;
      if (!ready || !element) return;
      stop();
      const position = options.position();
      if (position) {
        const anchor = position.key === null ? null : row(element, position.key);
        element.scrollTop = anchor
          ? anchoredScrollTop(
              position,
              element.scrollTop,
              anchor.getBoundingClientRect().top,
              element.getBoundingClientRect().top,
            )
          : position.scrollTop;
      }
      const returned = options.returnedFrom();
      const target = returned === null ? null : row(element, returned);
      if (!target) return;
      target.scrollIntoView({ block: 'nearest' });
      target.querySelector<HTMLElement>('a')?.focus({ preventScroll: true });
    },
    { immediate: true, flush: 'post' },
  );
}
