import { mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defineComponent, h, nextTick, ref } from 'vue';
import type { ListPosition } from '../lib/list-position.ts';
import { useListPosition } from './useListPosition.ts';

const VIEW_TOP = 100;
const ROW_HEIGHT = 40;
/** Where the first row's top is, as scrolling moves the rows. */
let rowsTop: number;
const scrollIntoView = vi.fn();

// Layout as the browser would give it: the list at VIEW_TOP, rows one under the other.
beforeEach(() => {
  rowsTop = VIEW_TOP;
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
    this: HTMLElement,
  ) {
    if (!this.dataset.entry) return { top: VIEW_TOP, bottom: VIEW_TOP + 400 } as DOMRect;
    const index = [...(this.parentElement?.children ?? [])].indexOf(this);
    const top = rowsTop + index * ROW_HEIGHT;
    return { top, bottom: top + ROW_HEIGHT } as DOMRect;
  });
  scrollIntoView.mockClear();
  HTMLElement.prototype.scrollIntoView = scrollIntoView;
});

afterEach(() => {
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

function setup(options: { position?: ListPosition; returnedFrom?: string } = {}) {
  const keys = ref<string[]>([]);
  const save = vi.fn<(position: ListPosition) => void>();
  const position = vi.fn(() => options.position ?? null);
  const wrapper = mount(
    defineComponent({
      setup() {
        const scroller = ref<HTMLElement | null>(null);
        useListPosition(scroller, {
          attr: 'entry',
          count: () => keys.value.length,
          position,
          returnedFrom: () => options.returnedFrom ?? null,
          save,
        });
        return () =>
          h(
            'div',
            { ref: scroller },
            keys.value.map((key) => h('div', { key, 'data-entry': key }, [h('a', { href: '#' })])),
          );
      },
    }),
    { attachTo: document.body },
  );
  const element = wrapper.element as HTMLElement;
  const load = async (...rows: string[]) => {
    keys.value = rows;
    await nextTick();
  };
  return { wrapper, element, save, position, load };
}

describe('useListPosition', () => {
  it('waits for rows, then scrolls back to where the list was, once', async () => {
    const { element, position, load } = setup({
      position: { key: null, offset: 0, scrollTop: 250 },
    });
    await nextTick();
    expect(position).not.toHaveBeenCalled();
    await load('1', '2');
    expect(element.scrollTop).toBe(250);
    element.scrollTop = 0;
    await load('1', '2', '3');
    expect(position).toHaveBeenCalledOnce();
    expect(element.scrollTop).toBe(0);
  });

  it("puts the row that was first in view back at its distance from the list's top", async () => {
    // Row 2 was 10 above the top; now rows arrived above it and it renders 80 below the top.
    const { element, load } = setup({ position: { key: '2', offset: -10, scrollTop: 999 } });
    await load('0', '1', '2');
    expect(element.scrollTop).toBe(2 * ROW_HEIGHT + 10);
  });

  it('falls back to the scroll offset when that row is gone', async () => {
    const { element, load } = setup({ position: { key: 'gone', offset: -10, scrollTop: 70 } });
    await load('1', '2');
    expect(element.scrollTop).toBe(70);
  });

  it('shows and focuses the row of the article the reader came back from', async () => {
    const { element, load } = setup({ returnedFrom: '2' });
    await load('1', '2');
    const row = element.querySelector('[data-entry="2"]');
    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'nearest' });
    expect(document.activeElement).toBe(row?.querySelector('a'));
  });

  it('saves the first row still in view when it unmounts', async () => {
    const { wrapper, element, save, load } = setup();
    await load('1', '2', '3');
    rowsTop = VIEW_TOP - 50;
    element.scrollTop = 50;
    wrapper.unmount();
    // Row 1 spans 50–90, above the list's top; row 2 spans 90–130.
    expect(save).toHaveBeenCalledWith({ key: '2', offset: -10, scrollTop: 50 });
  });
});
