import { enableAutoUnmount, flushPromises } from '@vue/test-utils';
import { afterEach, describe, expect, it } from 'vitest';
import { useUiStore } from '../../stores/ui.ts';
import { mountInApp } from '../../test/mount.ts';
import ConfirmDialog from './ConfirmDialog.vue';

enableAutoUnmount(afterEach);

/** The dialog's buttons, rendered in the overlay. */
const buttons = () => [...document.querySelectorAll<HTMLButtonElement>('.v-dialog button')];

async function ask() {
  const { pinia } = mountInApp(ConfirmDialog);
  const answer = useUiStore(pinia).confirm('Delete feed?', 'Its articles go too.', 'Delete');
  await flushPromises();
  return answer;
}

describe('ConfirmDialog', () => {
  it('asks, and answers yes with its action', async () => {
    const answer = ask();
    await flushPromises();
    expect(document.querySelector('.v-dialog')?.textContent).toContain('Its articles go too.');
    expect(buttons().map((b) => b.textContent.trim())).toEqual(['Cancel', 'Delete']);
    buttons()[1]?.click();
    await expect(answer).resolves.toBe(true);
  });

  it('answers no when cancelled', async () => {
    const answer = ask();
    await flushPromises();
    buttons()[0]?.click();
    await expect(answer).resolves.toBe(false);
  });
});
