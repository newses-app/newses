import { describe, expect, it } from 'vitest';
import { nextTick, ref } from 'vue';
import { withSetup } from '../test/mount.ts';
import { useDocumentTitle } from './useDocumentTitle.ts';

/** Without the isolates `t()` puts around parameters. */
const title = () => document.title.replace(/[\u2066-\u2069]/g, '');

describe('useDocumentTitle', () => {
  it('names the tab after the view, or the app alone without one', async () => {
    const view = ref<string | undefined>('Settings');
    withSetup(() => {
      useDocumentTitle(() => view.value);
    });
    expect(title()).toBe('Settings – Newses');
    view.value = undefined;
    await nextTick();
    expect(title()).toBe('Newses');
  });
});
