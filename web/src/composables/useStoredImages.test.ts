import { mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defineComponent, h, nextTick } from 'vue';
import { LOOKUP_WAIT_MS, useStoredImages } from './useStoredImages.ts';

let lookup: Promise<{ url: string; blob: Blob }[]>;
vi.mock('../offline/store.ts', () => ({
  currentStore: () => ({
    images: { where: () => ({ equals: () => ({ toArray: () => lookup }) }) },
  }),
}));

function mounted() {
  let state!: ReturnType<typeof useStoredImages>;
  mount(
    defineComponent({
      setup() {
        state = useStoredImages(() => 1);
        return () => h('div');
      },
    }),
  );
  return state;
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('useStoredImages', () => {
  it('is ready once the lookup answers', async () => {
    lookup = Promise.resolve([{ url: 'https://a.example/1.png', blob: new Blob([]) }]);
    const { images, ready } = mounted();
    expect(ready.value).toBe(false);
    await vi.waitFor(() => {
      expect(ready.value).toBe(true);
    });
    expect([...images.value.keys()]).toEqual(['https://a.example/1.png']);
  });

  it('stops waiting for a slow lookup, and still shows the images it finds', async () => {
    let answer!: (images: { url: string; blob: Blob }[]) => void;
    lookup = new Promise((resolve) => {
      answer = resolve;
    });
    const { images, ready } = mounted();
    vi.advanceTimersByTime(LOOKUP_WAIT_MS - 1);
    expect(ready.value).toBe(false);
    vi.advanceTimersByTime(1);
    expect(ready.value).toBe(true);
    answer([{ url: 'https://a.example/1.png', blob: new Blob([]) }]);
    await nextTick();
    await vi.waitFor(() => {
      expect(images.value.size).toBe(1);
    });
  });
});
