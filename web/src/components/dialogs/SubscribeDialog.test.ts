import { ApiError } from '@newses/shared/client';
import { QueryClient } from '@tanstack/vue-query';
import { enableAutoUnmount, flushPromises } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Router } from 'vue-router';
import { sessionVerified } from '../../composables/useSession.ts';
import { withoutIsolates } from '../../lib/message-params.ts';
import { i18n } from '../../plugins/i18n.ts';
import { useUiStore } from '../../stores/ui.ts';
import { connectivity } from '../../test/connectivity.ts';
import { button, mountInApp, overlay, testRouter } from '../../test/mount.ts';
import SubscribeDialog from './SubscribeDialog.vue';

const api = vi.hoisted(() => ({
  serverInfo: vi.fn<() => Promise<object>>(),
  categories: { list: () => Promise.resolve([{ id: 4, title: 'News' }]) },
  subscriptions: { subscribe: vi.fn<(body: object) => Promise<object>>() },
}));
const store = vi.hoisted(() => ({ db: null as object | null }));
const queueChanges = vi.hoisted(() => vi.fn(() => Promise.resolve()));
vi.mock('../../api.ts', async (importOriginal) => ({ ...(await importOriginal<object>()), api }));
vi.mock('../../offline/connectivity.ts', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  ...(await import('../../test/connectivity.ts')),
}));
vi.mock('../../offline/store.ts', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  currentStore: () => store.db,
}));
vi.mock('../../offline/outbox.ts', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  queueChanges,
}));
vi.mock('../../offline/registration.ts', () => ({ requestOutboxSync: () => Promise.resolve() }));

enableAutoUnmount(afterEach);
const { t } = i18n.global;

const subscribed = { status: 'subscribed', subscription: { id: 7, title: 'Blog' } };
const loginRequired = () =>
  new ApiError(502, 'fetch_failed', 'Login required', null, { reason: 'fetch_login_required' });

let router: Router;

async function open(shared: string | null = null) {
  router = await testRouter('/all');
  const { pinia } = mountInApp(SubscribeDialog, { router, queryClient: new QueryClient() });
  const ui = useUiStore(pinia);
  ui.subscribeUrl = shared;
  ui.subscribeOpen = true;
  await flushPromises();
  return ui;
}

async function subscribe(url?: string) {
  if (url !== undefined) await overlay().get('input[type="url"]').setValue(url);
  await overlay().get('form').trigger('submit');
  await flushPromises();
}

const alert = () => {
  const element = document.querySelector('.v-dialog .v-alert');
  return element ? withoutIsolates(element.textContent.trim()) : null;
};

beforeEach(() => {
  connectivity.value = 'online';
  sessionVerified.value = true;
  store.db = null;
  api.serverInfo.mockResolvedValue({ apiVersion: { major: 1, minor: 12 } });
  api.subscriptions.subscribe.mockReset().mockResolvedValue(subscribed);
});

describe('SubscribeDialog', () => {
  it('subscribes, then opens the new feed', async () => {
    const ui = await open();
    await subscribe(' https://blog.example/feed ');
    expect(api.subscriptions.subscribe).toHaveBeenCalledWith({
      url: 'https://blog.example/feed',
      categoryId: null,
    });
    expect(ui.subscribeOpen).toBe(false);
    expect(withoutIsolates(ui.notice?.text ?? '')).toBe('Subscribed to Blog.');
    await vi.waitFor(() => {
      expect(router.currentRoute.value.path).toBe('/f7');
    });
  });

  it('lets the reader choose among the feeds a page offers', async () => {
    api.subscriptions.subscribe.mockResolvedValueOnce({
      status: 'choose',
      candidates: [
        { url: 'https://blog.example/rss', title: 'RSS' },
        { url: 'https://blog.example/atom', title: null },
      ],
    });
    await open();
    await subscribe('https://blog.example');
    expect(overlay().text()).toContain(t('subscribe.choose'));
    expect(overlay().get('input[type="url"]').attributes('disabled')).toBeDefined();
    const radios = overlay().findAll<HTMLInputElement>('input[type="radio"]');
    expect(radios.map((r) => r.element.checked)).toEqual([true, false]);
    await radios[1]?.setValue(true);
    await subscribe();
    expect(api.subscriptions.subscribe).toHaveBeenLastCalledWith({
      url: 'https://blog.example/atom',
      categoryId: null,
    });
  });

  it('fills in a shared address, and starts afresh each time it opens', async () => {
    const ui = await open('https://shared.example/');
    expect(overlay().get<HTMLInputElement>('input[type="url"]').element.value).toBe(
      'https://shared.example/',
    );
    expect(ui.subscribeUrl).toBeNull();
    api.subscriptions.subscribe.mockRejectedValueOnce(new ApiError(422, 'invalid', 'x', null));
    await subscribe();
    expect(alert()).not.toBeNull();
    ui.subscribeOpen = false;
    await flushPromises();
    ui.subscribeOpen = true;
    await flushPromises();
    expect(overlay().get<HTMLInputElement>('input[type="url"]').element.value).toBe('');
    expect(alert()).toBeNull();
  });

  it('offline, keeps the subscription to make once the server answers', async () => {
    connectivity.value = 'offline';
    store.db = { outbox: { count: () => Promise.resolve(0) } };
    const ui = await open();
    await subscribe('https://blog.example/feed');
    expect(api.subscriptions.subscribe).not.toHaveBeenCalled();
    expect(queueChanges).toHaveBeenCalled();
    expect(ui.subscribeOpen).toBe(false);
    expect(withoutIsolates(ui.notice?.text ?? '')).toBe(
      withoutIsolates(t('offline.subscribeKept', { url: 'https://blog.example/feed' })),
    );
  });

  it('offers a login when the feed asks for one, and sends it', async () => {
    api.subscriptions.subscribe.mockRejectedValueOnce(loginRequired());
    await open();
    await subscribe('https://private.example/feed');
    expect(alert()).not.toBeNull();
    const fields = overlay().findAll<HTMLInputElement>('input[autocomplete]');
    const login = fields.find((f) => f.attributes('autocomplete') === 'off');
    const password = fields.find((f) => f.attributes('autocomplete') === 'new-password');
    await login?.setValue(' reader ');
    await password?.setValue('secret');
    await subscribe();
    expect(api.subscriptions.subscribe).toHaveBeenLastCalledWith({
      url: 'https://private.example/feed',
      categoryId: null,
      credentials: { login: 'reader', password: 'secret' },
    });
  });

  it('never keeps a login to send later', async () => {
    api.subscriptions.subscribe.mockRejectedValueOnce(loginRequired());
    await open();
    await subscribe('https://private.example/feed');
    connectivity.value = 'offline';
    await subscribe();
    expect(alert()).toBe(t('offline.needsConnection'));
    expect(api.subscriptions.subscribe).toHaveBeenCalledOnce();
  });

  it('offers no login on a server that cannot fetch with one', async () => {
    api.serverInfo.mockResolvedValue({ apiVersion: { major: 1, minor: 11 } });
    api.subscriptions.subscribe.mockRejectedValueOnce(loginRequired());
    await open();
    expect(overlay().find('input[type="checkbox"]').exists()).toBe(false);
    await subscribe('https://private.example/feed');
    expect(overlay().find('input[type="password"]').exists()).toBe(false);
  });

  it('closes on cancel', async () => {
    const ui = await open();
    await button(overlay(), t('common.cancel')).trigger('click');
    expect(ui.subscribeOpen).toBe(false);
  });
});
