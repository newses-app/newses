import 'fake-indexeddb/auto';
import type { PushMessage } from '@newses/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { openPushTarget, showPushMessage, type WorkerClients } from './push-worker.ts';
import { NAVIGATE_MESSAGE, NEW_ENTRIES_TAG, writePushConfig } from './worker-config.ts';

const message = (count: number, title: string, target = '/all'): PushMessage => ({
  type: 'new-entries',
  count,
  places: [{ title, count }],
  morePlaces: 0,
  target,
});

function registration(showing: PushMessage[] = []) {
  const shown: { title: string; options: NotificationOptions & { renotify?: boolean } }[] = [];
  return {
    shown,
    getNotifications: vi.fn(() =>
      Promise.resolve(showing.map((data) => ({ data, close: () => undefined }))),
    ),
    showNotification: (title: string, options: NotificationOptions & { renotify?: boolean }) => {
      shown.push({ title, options });
      return Promise.resolve();
    },
  };
}

function windows(...states: { visible?: boolean; focused?: boolean }[]) {
  const list = states.map((state) => ({
    visibilityState: state.visible ? ('visible' as const) : ('hidden' as const),
    focused: state.focused ?? false,
    focus: vi.fn(() => Promise.resolve()),
    postMessage: vi.fn(),
  }));
  const clients: WorkerClients & { opened: string[] } = {
    opened: [],
    matchAll: () => Promise.resolve(list),
    openWindow: (url) => {
      clients.opened.push(url);
      return Promise.resolve(null);
    },
  };
  return { list, clients };
}

afterEach(async () => {
  await writePushConfig(null);
});

describe('showPushMessage', () => {
  it("adds the message to the one showing, in the app's language", async () => {
    await writePushConfig({
      userId: 1,
      strings: {
        locale: 'es',
        title: { one: '{n} nuevo', other: '{n} nuevos' },
        lists: ['{0}', '{0} y {1}'],
        more: '{places} y {n} más',
        channel: 'Nuevos',
      },
    });
    const worker = registration([message(2, 'Tech', '/c1')]);

    await showPushMessage(worker, windows({}).clients, message(1500, 'Noticias', '/f3'));

    expect(worker.shown).toEqual([
      {
        title: '1502 nuevos',
        options: expect.objectContaining({
          body: 'Noticias y Tech',
          tag: NEW_ENTRIES_TAG,
          renotify: true,
          silent: false,
          lang: 'es',
          data: {
            type: 'new-entries',
            count: 1502,
            places: [
              { title: 'Noticias', count: 1500 },
              { title: 'Tech', count: 2 },
            ],
            morePlaces: 0,
            target: '/all',
          },
        }) as unknown,
      },
    ]);
  });

  it('notifies silently while the app is on screen', async () => {
    const worker = registration();
    await showPushMessage(worker, windows({ visible: true }).clients, message(1, 'Tech'));
    expect(worker.shown[0]?.options.silent).toBe(true);
    // Without the app's wording, the number and places.
    expect(worker.shown[0]).toMatchObject({ title: '1', options: { body: 'Tech' } });
  });

  it('ignores what is not a message of new entries', async () => {
    const worker = registration();
    await showPushMessage(worker, windows().clients, { type: 'other' });
    expect(worker.shown).toEqual([]);
  });
});

describe('openPushTarget', () => {
  it("opens the stream in the app's window", async () => {
    const { list, clients } = windows({}, { focused: true });
    const close = vi.fn();
    await openPushTarget({ data: message(1, 'Tech', '/f3'), close }, clients);
    expect(close).toHaveBeenCalled();
    expect(list[1]?.focus).toHaveBeenCalled();
    expect(list[1]?.postMessage).toHaveBeenCalledWith({ type: NAVIGATE_MESSAGE, target: '/f3' });
    expect(list[0]?.postMessage).not.toHaveBeenCalled();
  });

  it('opens a window when none is open', async () => {
    const { clients } = windows();
    await openPushTarget({ data: null, close: () => undefined }, clients);
    expect(clients.opened).toEqual(['/all']);
  });
});
