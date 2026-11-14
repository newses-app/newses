import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMemoryHistory, createRouter, createWebHistory } from 'vue-router';
import { appBackTargets, handleBack } from './back-button.ts';

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

describe('appBackTargets', () => {
  it('closes the drawer only where it covers the page', () => {
    const ui = { drawer: true };
    const router = createRouter({ history: createMemoryHistory(), routes: [] });
    const { closeDrawer } = appBackTargets(document, ui, router);
    document.body.innerHTML = '<nav class="v-navigation-drawer v-navigation-drawer--active"></nav>';
    expect(closeDrawer()).toBe(false);
    expect(ui.drawer).toBe(true);
    document.body.innerHTML =
      '<nav class="v-navigation-drawer v-navigation-drawer--temporary v-navigation-drawer--active"></nav>';
    expect(closeDrawer()).toBe(true);
    expect(ui.drawer).toBe(false);
  });

  it("goes back in the app's history, until its start", async () => {
    // Memory history keeps no `back` in its state; the browser's does.
    const router = createRouter({
      history: createWebHistory(),
      routes: [{ path: '/:any(.*)', component: { render: () => null } }],
    });
    const back = vi.spyOn(router, 'back');
    const { goBack } = appBackTargets(document, { drawer: false }, router);
    await router.push('/all');
    expect(goBack()).toBe(false);
    await router.push('/f7');
    expect(goBack()).toBe(true);
    expect(back).toHaveBeenCalledOnce();
  });
});
