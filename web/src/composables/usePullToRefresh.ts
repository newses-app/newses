import { computed, onBeforeUnmount, type Ref, shallowRef, watch } from 'vue';

/** How far a finger moves before the gesture counts as a pull or a sideways swipe. */
const SLOP = 10;

/**
 * Pulling `scroller` down with one finger while it is at its top calls `reload` on release, once
 * the indicator has travelled `threshold` pixels; the finger moves twice as far. Touch only, so
 * mouse drags and text selection are left alone, and a sideways swipe (the drawer) never starts
 * one. `busy` ignores pulls while a reload runs.
 */
export function usePullToRefresh(
  scroller: Ref<HTMLElement | null>,
  reload: () => unknown,
  { threshold = 72, busy = () => false }: { threshold?: number; busy?: () => boolean } = {},
) {
  /** How far the indicator has travelled, in pixels. */
  const distance = shallowRef(0);
  const armed = computed(() => distance.value >= threshold);

  let start: { x: number; y: number } | null = null;
  let pulling = false;

  function reset() {
    start = null;
    pulling = false;
    distance.value = 0;
  }

  function onStart(event: TouchEvent) {
    const touch = event.touches[0];
    const element = scroller.value;
    reset();
    if (event.touches.length !== 1 || !touch || !element || busy() || element.scrollTop > 0) return;
    start = { x: touch.clientX, y: touch.clientY };
  }

  function onMove(event: TouchEvent) {
    const touch = event.touches[0];
    if (!start) return;
    if (event.touches.length !== 1 || !touch || (scroller.value?.scrollTop ?? 0) > 0) {
      reset();
      return;
    }
    const dx = touch.clientX - start.x;
    const dy = touch.clientY - start.y;
    if (!pulling) {
      if (Math.abs(dx) < SLOP && Math.abs(dy) < SLOP) return;
      // Upwards scrolls the list; sideways is someone else's gesture.
      if (dy <= 0 || Math.abs(dx) >= Math.abs(dy)) {
        reset();
        return;
      }
      pulling = true;
    }
    distance.value = Math.min(Math.max(dy / 2, 0), threshold * 1.5);
  }

  function onEnd() {
    const release = armed.value && !busy();
    reset();
    if (release) void reload();
  }

  const listeners = [
    ['touchstart', onStart],
    ['touchmove', onMove],
    ['touchend', onEnd],
    ['touchcancel', reset],
  ] as const;
  const options = { passive: true };
  function detach(element: HTMLElement) {
    for (const [type, listener] of listeners) element.removeEventListener(type, listener);
  }
  watch(
    scroller,
    (element, previous) => {
      if (previous) detach(previous);
      reset();
      if (element)
        for (const [type, listener] of listeners) element.addEventListener(type, listener, options);
    },
    { immediate: true },
  );
  onBeforeUnmount(() => {
    if (scroller.value) detach(scroller.value);
  });

  return { distance, armed };
}
