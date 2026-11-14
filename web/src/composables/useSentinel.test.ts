import { mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defineComponent, h, nextTick, ref } from 'vue';
import { useSentinel } from './useSentinel.ts';

let observer: {
  callback: (records: Pick<IntersectionObserverEntry, 'isIntersecting'>[]) => void;
  options: IntersectionObserverInit | undefined;
  observed: Element[];
  disconnected: boolean;
};

beforeEach(() => {
  vi.stubGlobal(
    'IntersectionObserver',
    vi.fn(function (
      callback: typeof observer.callback,
      options?: IntersectionObserverInit,
    ): Partial<IntersectionObserver> {
      observer = { callback, options, observed: [], disconnected: false };
      return {
        observe: (element) => void observer.observed.push(element),
        unobserve: (element) => {
          observer.observed = observer.observed.filter((e) => e !== element);
        },
        disconnect: () => {
          observer.disconnected = true;
        },
      };
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('useSentinel', () => {
  it('observes the element as it changes, calls back when it comes into view, and stops on unmount', async () => {
    const onVisible = vi.fn();
    const shown = ref<'a' | 'b'>('a');
    const wrapper = mount(
      defineComponent({
        setup() {
          const element = ref<HTMLElement | null>(null);
          useSentinel(element, onVisible);
          return () => h('div', { ref: element, key: shown.value, id: shown.value });
        },
      }),
    );
    await nextTick();
    expect(observer.options).toEqual({ rootMargin: '400px' });
    expect(observer.observed.map((e) => e.id)).toEqual(['a']);

    observer.callback([{ isIntersecting: false }]);
    expect(onVisible).not.toHaveBeenCalled();
    observer.callback([{ isIntersecting: false }, { isIntersecting: true }]);
    expect(onVisible).toHaveBeenCalledOnce();

    shown.value = 'b';
    await nextTick();
    await nextTick();
    expect(observer.observed.map((e) => e.id)).toEqual(['b']);

    wrapper.unmount();
    expect(observer.disconnected).toBe(true);
  });
});
