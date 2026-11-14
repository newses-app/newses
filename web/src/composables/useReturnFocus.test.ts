import { afterEach, describe, expect, it } from 'vitest';
import { nextTick, ref } from 'vue';
import { withSetup } from '../test/mount.ts';
import { useReturnFocus } from './useReturnFocus.ts';

const button = (id: string) => {
  const element = document.createElement('button');
  element.id = id;
  document.body.append(element);
  return element;
};

afterEach(() => {
  document.body.replaceChildren();
});

describe('useReturnFocus', () => {
  it('focuses what had focus when the dialog opened, once it has closed', async () => {
    const open = ref(false);
    const { result: returnFocus } = withSetup(() => useReturnFocus(() => open.value));
    const opener = button('opener');
    opener.focus();
    open.value = true;
    button('inside').focus();
    open.value = false;
    await nextTick();
    returnFocus();
    expect(document.activeElement).toBe(opener);
  });

  it('does nothing when that element has gone, or for a second call', () => {
    const open = ref(false);
    const { result: returnFocus } = withSetup(() => useReturnFocus(() => open.value));
    const opener = button('opener');
    opener.focus();
    open.value = true;
    const inside = button('inside');
    inside.focus();
    opener.remove();
    returnFocus();
    expect(document.activeElement).toBe(inside);

    open.value = false;
    open.value = true;
    returnFocus();
    inside.blur();
    returnFocus();
    expect(document.activeElement).toBe(document.body);
  });
});
