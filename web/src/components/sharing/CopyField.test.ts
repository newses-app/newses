import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { useUiStore } from '../../stores/ui.ts';
import { mountWithPlugins } from '../../test/mount.ts';
import CopyField from './CopyField.vue';

function setup(writeText: (text: string) => Promise<void>) {
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
  const pinia = createPinia();
  setActivePinia(pinia);
  const field = mountWithPlugins(CopyField, {
    props: { value: 'https://reader.example/public/share/abc', label: 'Link' },
    global: { plugins: [pinia] },
  });
  return { field, ui: useUiStore(pinia) };
}

afterEach(() => {
  Reflect.deleteProperty(navigator, 'clipboard');
});

describe('CopyField', () => {
  it('shows the value left to right, and copies it', async () => {
    const writeText = vi.fn(() => Promise.resolve());
    const { field, ui } = setup(writeText);
    expect(field.get('input').element.value).toBe('https://reader.example/public/share/abc');
    expect(field.get('input').attributes('dir')).toBe('ltr');
    const button = field.get('button');
    expect(button.attributes('aria-label')).toContain('Copy');
    await button.trigger('click');
    expect(writeText).toHaveBeenCalledWith('https://reader.example/public/share/abc');
    expect(ui.notice).toEqual({ text: 'Copied', error: false });
  });

  it('says to copy by hand when the clipboard refuses', async () => {
    const { field, ui } = setup(() => Promise.reject(new Error('denied')));
    await field.get('button').trigger('click');
    await vi.waitFor(() => {
      expect(ui.notice?.error).toBe(true);
    });
    expect(ui.notice?.text).toBe('Could not copy; select the text and copy it instead.');
  });
});
