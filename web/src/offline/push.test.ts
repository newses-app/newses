import 'fake-indexeddb/auto';
import type { NotificationStrings } from '@newses/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  disableWebPush,
  enableWebPush,
  renewWebPush,
  webPushSignedOut,
  webPushState,
} from './push.ts';
import { readPushConfig, writePushConfig } from './worker-config.ts';

const api = vi.hoisted(() => ({
  push: { subscribe: vi.fn(() => Promise.resolve()), unsubscribe: vi.fn(() => Promise.resolve()) },
}));
vi.mock('../api.ts', () => ({ api }));

const strings: NotificationStrings = {
  locale: 'en',
  title: { other: '{n} new' },
  lists: ['{0}'],
  more: '{places} +{n}',
  channel: 'New',
};
const KEY_A = btoa(String.fromCharCode(...new Uint8Array(65).fill(1))).replace(/=+$/, '');
const KEY_B = btoa(String.fromCharCode(...new Uint8Array(65).fill(2))).replace(/=+$/, '');

/** A browser's push subscription for `key`, and what it says of itself. */
function subscription(key: string, endpoint: string) {
  const bytes = Uint8Array.from(atob(key), (c) => c.charCodeAt(0));
  const sub = {
    endpoint,
    options: { applicationServerKey: bytes.buffer },
    unsubscribe: vi.fn(() => {
      browser.subscribed = null;
      return Promise.resolve(true);
    }),
    toJSON: () => ({ endpoint, keys: { p256dh: 'device-key', auth: 'device-auth' } }),
  };
  return sub;
}

const browser = {
  permission: 'default' as NotificationPermission,
  answer: 'granted' as NotificationPermission,
  subscribed: null as ReturnType<typeof subscription> | null,
  created: 0,
};

beforeEach(() => {
  browser.permission = 'default';
  browser.answer = 'granted';
  browser.subscribed = null;
  browser.created = 0;
  const registration = {
    pushManager: {
      getSubscription: () => Promise.resolve(browser.subscribed),
      subscribe: ({ applicationServerKey }: { applicationServerKey: Uint8Array }) => {
        const key = btoa(String.fromCharCode(...applicationServerKey)).replace(/=+$/, '');
        browser.subscribed = subscription(key, `https://push.example/${String(++browser.created)}`);
        return Promise.resolve(browser.subscribed);
      },
    },
  };
  Object.defineProperty(navigator, 'serviceWorker', {
    configurable: true,
    value: {
      ready: Promise.resolve(registration),
      getRegistration: () => Promise.resolve(registration),
    },
  });
  vi.stubGlobal('Notification', {
    get permission() {
      return browser.permission;
    },
    requestPermission: () => {
      browser.permission = browser.answer;
      return Promise.resolve(browser.answer);
    },
  });
  api.push.subscribe.mockClear();
  api.push.unsubscribe.mockClear();
});

afterEach(async () => {
  vi.unstubAllGlobals();
  Reflect.deleteProperty(navigator, 'serviceWorker');
  await writePushConfig(null);
});

describe('web push', () => {
  it('subscribes once allowed and binds the subscription to the session', async () => {
    expect(await enableWebPush(7, KEY_A, strings)).toBe('on');
    expect(api.push.subscribe).toHaveBeenCalledWith({
      endpoint: 'https://push.example/1',
      keys: { p256dh: 'device-key', auth: 'device-auth' },
    });
    expect(await readPushConfig()).toMatchObject({ userId: 7, strings });
    expect(await webPushState(7)).toBe('on');
    // Another user signed in here does not have it on.
    expect(await webPushState(8)).toBe('off');
  });

  it('stays off when the reader refuses', async () => {
    browser.answer = 'denied';
    expect(await enableWebPush(7, KEY_A, strings)).toBe('denied');
    expect(browser.subscribed).toBeNull();
    expect(await webPushState(7)).toBe('denied');
  });

  it('turns off here and on the server', async () => {
    await enableWebPush(7, KEY_A, strings);
    await disableWebPush();
    expect(api.push.unsubscribe).toHaveBeenCalled();
    expect(browser.subscribed).toBeNull();
    expect(await readPushConfig()).toBeUndefined();
  });

  it('binds the subscription again at launch, subscribing again for a new key', async () => {
    await enableWebPush(7, KEY_A, strings);
    api.push.subscribe.mockClear();

    await renewWebPush(7, KEY_A, { ...strings, locale: 'es' });
    expect(api.push.subscribe).toHaveBeenLastCalledWith(
      expect.objectContaining({ endpoint: 'https://push.example/1' }),
    );
    expect((await readPushConfig())?.strings.locale).toBe('es');

    await renewWebPush(7, KEY_B, strings);
    expect(api.push.subscribe).toHaveBeenLastCalledWith(
      expect.objectContaining({ endpoint: 'https://push.example/2' }),
    );
  });

  it("drops another user's subscription, and one the server no longer takes", async () => {
    await enableWebPush(7, KEY_A, strings);
    api.push.subscribe.mockClear();
    await renewWebPush(8, KEY_A, strings);
    expect(browser.subscribed).toBeNull();
    expect(api.push.subscribe).not.toHaveBeenCalled();

    await enableWebPush(7, KEY_A, strings);
    await renewWebPush(7, null, strings);
    expect(browser.subscribed).toBeNull();
    expect(await readPushConfig()).toBeUndefined();
  });

  it('stops on signing out', async () => {
    await enableWebPush(7, KEY_A, strings);
    await webPushSignedOut();
    expect(browser.subscribed).toBeNull();
    expect(await readPushConfig()).toBeUndefined();
  });
});
