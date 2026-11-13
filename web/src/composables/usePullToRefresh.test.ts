import { mount } from '@vue/test-utils';
import { describe, expect, it, vi } from 'vitest';
import { defineComponent, h, nextTick, ref } from 'vue';
import { usePullToRefresh } from './usePullToRefresh.ts';

type Point = [x: number, y: number];

function touch(target: HTMLElement, type: string, ...points: Point[]) {
  const event = new Event(type);
  Object.defineProperty(event, 'touches', {
    value: points.map(([clientX, clientY]) => ({ clientX, clientY })),
  });
  target.dispatchEvent(event);
}

async function setup({ busy = false, scrollTop = 0 } = {}) {
  const reload = vi.fn();
  const state = { busy };
  let pull!: ReturnType<typeof usePullToRefresh>;
  const wrapper = mount(
    defineComponent({
      setup() {
        const scroller = ref<HTMLElement | null>(null);
        pull = usePullToRefresh(scroller, reload, { threshold: 72, busy: () => state.busy });
        return () => h('div', { ref: scroller });
      },
    }),
  );
  // The listeners attach once the ref is set.
  await nextTick();
  const element = wrapper.element as HTMLElement;
  element.scrollTop = scrollTop;
  /** One finger from the top down by `dy` (and across by `dx`), in steps, then lifted. */
  const drag = (dy: number, dx = 0, { lift = true } = {}) => {
    touch(element, 'touchstart', [100, 100]);
    for (let step = 1; step <= 4; step++)
      touch(element, 'touchmove', [100 + (dx * step) / 4, 100 + (dy * step) / 4]);
    if (lift) touch(element, 'touchend');
  };
  return { reload, state, pull: () => pull, element, drag, wrapper };
}

describe('usePullToRefresh', () => {
  it('reloads once a pull passes the threshold and is let go', async () => {
    const { reload, pull, drag } = await setup();
    drag(200, 0, { lift: false });
    expect(pull().armed.value).toBe(true);
    expect(pull().distance.value).toBe(100);
    expect(reload).not.toHaveBeenCalled();
    drag(200);
    expect(reload).toHaveBeenCalledTimes(1);
    expect(pull().distance.value).toBe(0);
  });

  it('does nothing for a short pull', async () => {
    const { reload, pull, drag } = await setup();
    drag(100, 0, { lift: false });
    expect(pull().distance.value).toBe(50);
    expect(pull().armed.value).toBe(false);
    drag(100);
    expect(reload).not.toHaveBeenCalled();
  });

  it('leaves a list scrolled away from its top alone', async () => {
    const { reload, pull, drag } = await setup({ scrollTop: 40 });
    drag(300, 0, { lift: false });
    expect(pull().distance.value).toBe(0);
    drag(300);
    expect(reload).not.toHaveBeenCalled();
  });

  it('leaves sideways swipes and upward scrolls alone', async () => {
    const { reload, drag } = await setup();
    drag(160, 300);
    drag(-300);
    expect(reload).not.toHaveBeenCalled();
  });

  it('ignores pulls while a reload runs', async () => {
    const { reload, state, drag } = await setup({ busy: true });
    drag(300);
    expect(reload).not.toHaveBeenCalled();
    state.busy = false;
    drag(300);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('drops the pull when a second finger lands or the touch is cancelled', async () => {
    const { reload, pull, element } = await setup();
    touch(element, 'touchstart', [100, 100]);
    touch(element, 'touchmove', [100, 400]);
    touch(element, 'touchmove', [100, 400], [200, 400]);
    touch(element, 'touchend');
    touch(element, 'touchstart', [100, 100]);
    touch(element, 'touchmove', [100, 400]);
    touch(element, 'touchcancel');
    expect(pull().distance.value).toBe(0);
    touch(element, 'touchend');
    expect(reload).not.toHaveBeenCalled();
  });

  it('stops listening once unmounted', async () => {
    const { reload, element, wrapper } = await setup();
    wrapper.unmount();
    touch(element, 'touchstart', [100, 100]);
    touch(element, 'touchmove', [100, 400]);
    touch(element, 'touchend');
    expect(reload).not.toHaveBeenCalled();
  });
});
