import { enableAutoUnmount, flushPromises, type VueWrapper } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Router } from 'vue-router';
import { withoutIsolates } from '../lib/message-params.ts';
import { i18n } from '../plugins/i18n.ts';
import { inLayout, mountInApp, testRouter } from '../test/mount.ts';
import ConnectView from './ConnectView.vue';

const platform = vi.hoisted(() => ({
  state: {
    profiles: [] as { id: string }[],
    serverUrl: null as string | null,
    token: null as string | null,
  },
}));
const checkServer = vi.hoisted(() => vi.fn<(origin: string) => Promise<object>>());
const connectTo = vi.hoisted(() => vi.fn<(origin: string, name: string | null) => Promise<void>>());
vi.mock('../platform/index.ts', async (importOriginal) => {
  const original = await importOriginal<typeof import('../platform/index.ts')>();
  return {
    ...original,
    connection: { ...original.connection, state: platform.state },
    bridge: { ...original.bridge, appVersion: '1.2.0' },
  };
});
vi.mock('../lib/server-url.ts', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  checkServer,
}));
vi.mock('../platform/profiles.ts', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  connectTo,
}));

enableAutoUnmount(afterEach);
const { t } = i18n.global;

let router: Router;

async function open() {
  router = await testRouter('/settings', ['login', 'about']);
  await router.push('/connect');
  const { wrapper } = mountInApp(inLayout(ConnectView), { router });
  await flushPromises();
  return wrapper;
}

async function connect(view: VueWrapper, address: string) {
  await view.get('input').setValue(address);
  await view.get('form').trigger('submit');
  await flushPromises();
}

const alert = (view: VueWrapper) =>
  view.find('.v-alert').exists() ? withoutIsolates(view.get('.v-alert').text()) : null;
const button = (view: VueWrapper, label: string) =>
  view.findAll('button').find((b) => b.text() === label);

beforeEach(() => {
  Object.assign(platform.state, { profiles: [], serverUrl: null, token: null });
  checkServer.mockReset().mockResolvedValue({ status: 'ok', info: { name: 'Home' } });
  connectTo.mockReset().mockResolvedValue();
});

describe('ConnectView', () => {
  it('connects to a Newses server, taking its address without https://', async () => {
    const view = await open();
    expect(view.text()).toContain(t('connect.title'));
    expect(view.text()).toContain('1.2.0');
    await connect(view, ' reader.example.com/ ');
    expect(checkServer).toHaveBeenCalledWith('https://reader.example.com');
    expect(connectTo).toHaveBeenCalledWith('https://reader.example.com', 'Home');
  });

  it('refuses an address that is not https', async () => {
    const view = await open();
    await connect(view, 'http://reader.example.com');
    expect(alert(view)).toBe(t('connect.invalid'));
    expect(checkServer).not.toHaveBeenCalled();
  });

  it.each(['unreachable', 'notNewses', 'incompatible'])(
    'says why it cannot connect: %s',
    async (status) => {
      checkServer.mockResolvedValue({ status });
      const view = await open();
      await connect(view, 'reader.example.com');
      expect(alert(view)).toBe(
        withoutIsolates(t(`connect.${status}`, { host: 'reader.example.com' })),
      );
      expect(connectTo).not.toHaveBeenCalled();
    },
  );

  it('warns of an older server, and connects once the reader goes on', async () => {
    checkServer.mockResolvedValue({ status: 'older', info: { version: '1.0.0', name: null } });
    const view = await open();
    await connect(view, 'reader.example.com');
    expect(alert(view)).toBe(withoutIsolates(t('connect.older', { version: '1.0.0' })));
    expect(connectTo).not.toHaveBeenCalled();
    await button(view, t('connect.continue'))?.trigger('click');
    await flushPromises();
    expect(connectTo).toHaveBeenCalledWith('https://reader.example.com', null);
  });

  it('goes back to the server it came from, signed in or to sign in', async () => {
    Object.assign(platform.state, {
      profiles: [{ id: 'p1' }],
      serverUrl: 'https://reader.example.com',
    });
    const view = await open();
    expect(view.text()).toContain(t('connect.addTitle'));
    expect(view.get('input').element.value).toBe('https://reader.example.com');
    await connect(view, 'https://reader.example.com');
    expect(router.currentRoute.value.name).toBe('login');
    expect(connectTo).not.toHaveBeenCalled();

    platform.state.token = 'token';
    const signedIn = await open();
    await connect(signedIn, 'https://reader.example.com');
    expect(router.currentRoute.value.path).toBe('/all');

    const back = vi.spyOn(router, 'back');
    await button(signedIn, t('common.cancel'))?.trigger('click');
    expect(back).toHaveBeenCalled();
  });
});
