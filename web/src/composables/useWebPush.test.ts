import { QueryClient } from '@tanstack/vue-query';
import { enableAutoUnmount, flushPromises } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { nextTick } from 'vue';
import { bridge } from '../platform/index.ts';
import { i18n } from '../plugins/i18n.ts';
import { withSetup } from '../test/mount.ts';
import { SESSION_KEY, sessionVerified } from './useSession.ts';
import { useWebPush } from './useWebPush.ts';

const push = vi.hoisted(() => ({
  support: 'supported',
  renewWebPush: vi.fn<(...args: unknown[]) => Promise<void>>(() => Promise.resolve()),
  rewordWebPush: vi.fn<(...args: unknown[]) => Promise<void>>(() => Promise.resolve()),
  closeNewEntriesNotification: vi.fn(() => Promise.resolve()),
}));
const serverInfo = vi.hoisted(() => vi.fn());

vi.mock('../offline/push.ts', () => ({ ...push, webPushSupport: () => push.support }));
vi.mock('../api.ts', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  api: { serverInfo },
}));

enableAutoUnmount(afterEach);

let visibility: DocumentVisibilityState;
const platform = bridge as { platform: string };

function setup() {
  const queryClient = new QueryClient();
  queryClient.setQueryData(SESSION_KEY, { user: { id: 7 } });
  return withSetup(() => {
    useWebPush();
  }, queryClient);
}

beforeEach(() => {
  platform.platform = 'web';
  push.support = 'supported';
  sessionVerified.value = false;
  visibility = 'visible';
  vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibility);
  serverInfo.mockResolvedValue({ push: { key: 'VAPID' } });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  i18n.global.locale.value = 'en';
});

describe('useWebPush', () => {
  it("binds the browser's subscription to the session once it is verified, with the server's key", async () => {
    setup();
    await flushPromises();
    expect(push.renewWebPush).not.toHaveBeenCalled();
    sessionVerified.value = true;
    await flushPromises();
    expect(push.renewWebPush).toHaveBeenCalledWith(7, 'VAPID', expect.any(Object));
  });

  it('leaves the subscription as it was while the server cannot be reached', async () => {
    serverInfo.mockRejectedValue(new TypeError('Failed to fetch'));
    sessionVerified.value = true;
    setup();
    await flushPromises();
    expect(push.renewWebPush).not.toHaveBeenCalled();
  });

  it('words notifications again when the language changes', async () => {
    setup();
    i18n.global.locale.value = 'de';
    await nextTick();
    expect(push.rewordWebPush).toHaveBeenCalledOnce();
  });

  it('closes the notification showing once the reader is back', () => {
    visibility = 'hidden';
    setup();
    expect(push.closeNewEntriesNotification).not.toHaveBeenCalled();
    visibility = 'visible';
    document.dispatchEvent(new Event('visibilitychange'));
    expect(push.closeNewEntriesNotification).toHaveBeenCalledOnce();
  });

  it('does nothing in the apps, or where the browser cannot push', async () => {
    platform.platform = 'desktop';
    sessionVerified.value = true;
    setup();
    push.support = 'unsupported';
    platform.platform = 'web';
    setup();
    await flushPromises();
    expect(serverInfo).not.toHaveBeenCalled();
    expect(push.closeNewEntriesNotification).not.toHaveBeenCalled();
  });
});
