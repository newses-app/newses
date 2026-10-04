import { onBeforeUnmount, type Ref, watch } from 'vue';

/** Calls `onVisible` whenever `element` scrolls into view (e.g. to load the next page). */
export function useSentinel(element: Ref<HTMLElement | null>, onVisible: () => void): void {
  const observer = new IntersectionObserver(
    (records) => {
      if (records.some((r) => r.isIntersecting)) onVisible();
    },
    { rootMargin: '400px' },
  );
  watch(element, (current, previous) => {
    if (previous) observer.unobserve(previous);
    if (current) observer.observe(current);
  });
  onBeforeUnmount(() => {
    observer.disconnect();
  });
}
