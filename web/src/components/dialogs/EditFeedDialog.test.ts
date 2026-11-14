import type { Subscription } from '@newses/shared';
import { ApiError } from '@newses/shared/client';
import { QueryClient } from '@tanstack/vue-query';
import { enableAutoUnmount, flushPromises } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMemoryHistory, createRouter, type Router } from 'vue-router';
import { CATEGORIES_KEY, SUBSCRIPTIONS_KEY } from '../../composables/useFeeds.ts';
import { sessionVerified } from '../../composables/useSession.ts';
import { withoutIsolates } from '../../lib/message-params.ts';
import { i18n } from '../../plugins/i18n.ts';
import { useUiStore } from '../../stores/ui.ts';
import { connectivity } from '../../test/connectivity.ts';
import { button, mountInApp, overlay } from '../../test/mount.ts';
import { spyInvalidations } from '../../test/queries.ts';
import EditFeedDialog from './EditFeedDialog.vue';

const api = vi.hoisted(() => ({
  serverInfo: vi.fn<() => Promise<object>>(),
  subscriptions: {
    list: vi.fn<() => Promise<object[]>>(),
    update: vi.fn<(id: number, changes: object) => Promise<object>>(),
    refresh: vi.fn<(id: number) => Promise<void>>(),
    unsubscribe: vi.fn<(id: number) => Promise<void>>(),
  },
  categories: { list: vi.fn<() => Promise<object[]>>() },
}));
vi.mock('../../api.ts', async (importOriginal) => ({ ...(await importOriginal<object>()), api }));
vi.mock('../../offline/connectivity.ts', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  ...(await import('../../test/connectivity.ts')),
}));

enableAutoUnmount(afterEach);
const { t } = i18n.global;

const feed = (fields: Partial<Subscription>) =>
  ({
    id: 7,
    title: 'Blog',
    customTitle: null,
    url: 'https://blog.example/feed',
    categoryId: 4,
    sortOrder: 0,
    updateIntervalMinutes: null,
    purgeDays: null,
    fullText: false,
    paused: false,
    hideFromAll: false,
    authLogin: null,
    lastFetchedAt: null,
    lastError: null,
    lastErrorAt: null,
    disabled: false,
    nextFetchAt: null,
    iconUrl: null,
    ...fields,
  }) as Subscription;

let router: Router;

async function open(fields: Partial<Subscription> = {}, minor = 12) {
  api.serverInfo.mockResolvedValue({ apiVersion: { major: 1, minor } });
  const subscriptions = [feed(fields), feed({ id: 8, title: 'News', sortOrder: 1 })];
  api.subscriptions.list.mockResolvedValue(subscriptions);
  const queryClient = new QueryClient();
  queryClient.setQueryData(SUBSCRIPTIONS_KEY, subscriptions);
  queryClient.setQueryData(CATEGORIES_KEY, [{ id: 4, title: 'Reading', parentId: null }]);
  router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: '/:stream', component: { render: () => null } }],
  });
  await router.push('/f7');
  const { pinia } = mountInApp(EditFeedDialog, { router, queryClient });
  const ui = useUiStore(pinia);
  await flushPromises();
  ui.editSubscriptionId = 7;
  await flushPromises();
  return { ui, invalidations: spyInvalidations(queryClient) };
}

async function save() {
  await overlay().get('form').trigger('submit');
  await flushPromises();
}

/** The checkbox labelled `label`. */
const checkbox = (label: string) => {
  const box = overlay()
    .findAll('.v-checkbox')
    .find((c) => c.text().includes(label));
  if (!box) throw new Error(`No checkbox ${label}`);
  return box.get<HTMLInputElement>('input');
};

const CHANGES = {
  title: null,
  updateIntervalMinutes: null,
  purgeDays: null,
  fullText: false,
  paused: false,
  hideFromAll: false,
};

beforeEach(() => {
  connectivity.value = 'online';
  sessionVerified.value = true;
  api.subscriptions.update.mockReset().mockResolvedValue({});
  api.subscriptions.refresh.mockReset().mockResolvedValue();
  api.subscriptions.unsubscribe.mockReset().mockResolvedValue();
  api.categories.list.mockResolvedValue([{ id: 4, title: 'Reading', parentId: null }]);
});

describe('EditFeedDialog', () => {
  it("opens with the feed's settings", async () => {
    await open({ customTitle: 'My blog', fullText: true });
    expect(overlay().text()).toContain('https://blog.example/feed');
    const title = overlay().get<HTMLInputElement>('input[placeholder="Blog"]');
    expect(title.element.value).toBe('My blog');
    expect(checkbox(t('feeds.fullText')).element.checked).toBe(true);
    expect(overlay().text()).toContain(t('feeds.neverFetched'));
  });

  it('saves its settings, then closes', async () => {
    const { ui } = await open();
    await overlay().get('input[placeholder="Blog"]').setValue('  My blog  ');
    await checkbox(t('feeds.fullText')).setValue(true);
    await save();
    expect(api.subscriptions.update).toHaveBeenCalledWith(7, {
      ...CHANGES,
      title: 'My blog',
      fullText: true,
    });
    expect(ui.editSubscriptionId).toBeNull();
  });

  it('refetches the lists when the feed is hidden from All or shown again', async () => {
    const { invalidations } = await open();
    await checkbox(t('feeds.hideFromAll')).setValue(true);
    await save();
    expect(invalidations.keys()).toContainEqual(['entries']);
  });

  it('leaves out the options an older server does not have', async () => {
    await open({ paused: undefined } as unknown as Partial<Subscription>, 3);
    expect(overlay().text()).not.toContain(t('feeds.pause'));
    expect(overlay().text()).not.toContain(t('feedLogin.needsLogin'));
    expect(overlay().text()).not.toContain(t('feedDebug.open'));
    await save();
    expect(api.subscriptions.update).toHaveBeenCalledWith(7, {
      title: null,
      updateIntervalMinutes: null,
      purgeDays: null,
      fullText: false,
    });
  });

  it('sends a changed login with the settings, and never keeps it to send later', async () => {
    const { ui } = await open({ authLogin: 'ann' });
    expect(checkbox(t('feedLogin.needsLogin')).element.checked).toBe(true);
    await checkbox(t('feedLogin.needsLogin')).setValue(false);
    connectivity.value = 'offline';
    await save();
    expect(ui.notice?.text).toBe(t('offline.needsConnection'));
    expect(api.subscriptions.update).not.toHaveBeenCalled();

    connectivity.value = 'online';
    await save();
    expect(api.subscriptions.update).toHaveBeenCalledWith(7, { ...CHANGES, credentials: null });
  });

  it('asks the server to check the feed now, while it can be reached', async () => {
    const { ui } = await open();
    await button(overlay(), t('feeds.refresh')).trigger('click');
    await flushPromises();
    expect(api.subscriptions.refresh).toHaveBeenCalledWith(7);
    expect(ui.notice?.text).toBe(t('feeds.refreshRequested'));

    connectivity.value = 'unreachable';
    await button(overlay(), t('feeds.refresh')).trigger('click');
    expect(api.subscriptions.refresh).toHaveBeenCalledOnce();
    expect(ui.notice?.text).toBe(t('offline.needsConnection'));
  });

  it('unsubscribes once confirmed, leaving the stream of the feed', async () => {
    const { ui } = await open();
    await button(overlay(), t('feeds.unsubscribe')).trigger('click');
    expect(withoutIsolates(ui.confirmRequest?.text ?? '')).toContain('Blog');
    ui.confirmRequest?.resolve(true);
    await flushPromises();
    expect(api.subscriptions.unsubscribe).toHaveBeenCalledWith(7);
    expect(ui.editSubscriptionId).toBeNull();
    await vi.waitFor(() => {
      expect(router.currentRoute.value.path).toBe('/all');
    });
  });

  it('says why a change failed, and stays open', async () => {
    api.subscriptions.update.mockRejectedValue(new ApiError(422, 'invalid', 'x', null));
    const { ui } = await open();
    await save();
    expect(ui.notice?.error).toBe(true);
    expect(ui.editSubscriptionId).toBe(7);
  });

  it("opens the feed debugger, and shows the feed's last error", async () => {
    const { ui } = await open({
      lastError: 'HTTP 404',
      lastErrorAt: new Date().toISOString(),
      lastFetchedAt: new Date().toISOString(),
    });
    expect(overlay().get('.v-alert').text()).toContain('HTTP 404');
    await button(overlay(), t('feedDebug.open')).trigger('click');
    expect(ui.debugSubscriptionId).toBe(7);
  });

  it('closes on cancel', async () => {
    const { ui } = await open();
    await button(overlay(), t('common.cancel')).trigger('click');
    expect(ui.editSubscriptionId).toBeNull();
  });
});
