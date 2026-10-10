import { afterEach, describe, expect, it, vi } from 'vitest';
import { handleBack } from './back-button.ts';

afterEach(() => {
  document.body.innerHTML = '';
});

const targets = (drawer = false, history = false) => ({
  closeDrawer: vi.fn(() => drawer),
  goBack: vi.fn(() => history),
});

describe('handleBack', () => {
  it('closes an open dialog with Escape first', () => {
    document.body.innerHTML = '<div class="v-overlay v-dialog v-overlay--active"></div>';
    const keys: string[] = [];
    window.addEventListener('keydown', (event) => keys.push(event.key), { once: true });
    const all = targets(true, true);
    expect(handleBack(document, all)).toBe(true);
    expect(keys).toEqual(['Escape']);
    expect(all.closeDrawer).not.toHaveBeenCalled();
  });

  it('ignores snackbars, then closes the drawer before going back', () => {
    document.body.innerHTML = '<div class="v-overlay v-snackbar v-overlay--active"></div>';
    const all = targets(true, true);
    expect(handleBack(document, all)).toBe(true);
    expect(all.closeDrawer).toHaveBeenCalled();
    expect(all.goBack).not.toHaveBeenCalled();
  });

  it('goes back when nothing is open', () => {
    const all = targets(false, true);
    expect(handleBack(document, all)).toBe(true);
    expect(all.goBack).toHaveBeenCalled();
  });

  it('lets the app exit at the start of its history', () => {
    expect(handleBack(document, targets())).toBe(false);
  });
});
