import { ApiError } from '@newses/shared/client';
import type { Entry } from '@newses/shared';
import { QueryClient } from '@tanstack/vue-query';
import { enableAutoUnmount, flushPromises } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SESSION_KEY } from '../../composables/useSession.ts';
import { withoutIsolates } from '../../lib/message-params.ts';
import { shareUrl } from '../../lib/sharing.ts';
import { bridge } from '../../platform/index.ts';
import { i18n } from '../../plugins/i18n.ts';
import { useUiStore } from '../../stores/ui.ts';
import { mountInApp, overlay, testRouter } from '../../test/mount.ts';
import EmailDialog from './EmailDialog.vue';

const api = vi.hoisted(() => ({
  serverInfo: vi.fn<() => Promise<object>>(),
  auth: { session: vi.fn<() => Promise<object>>() },
  entries: { email: vi.fn<(id: number, body: object) => Promise<void>>() },
}));
vi.mock('../../api.ts', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  api,
}));

enableAutoUnmount(afterEach);
const { t } = i18n.global;

const ENTRY = { id: 7, title: 'Big story', link: 'https://news.example/a', shareId: null } as Entry;
const SHARE_ID = '5f0c2c1e-8d7a-4b7e-9c1a-2f3d4e5f6a7b';

async function opened({
  mail = true,
  email = 'ann@example.com',
  entry = ENTRY,
}: { mail?: boolean; email?: string | null; entry?: Entry } = {}) {
  api.serverInfo.mockResolvedValue({ product: 'newses', mail });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const session = { user: { id: 1, login: 'ann', email }, csrfToken: 'csrf', iconsPath: '/x' };
  queryClient.setQueryData(SESSION_KEY, session);
  api.auth.session.mockResolvedValue(session);
  const { pinia } = mountInApp(EmailDialog, { queryClient, router: await testRouter('/all') });
  const ui = useUiStore(pinia);
  ui.emailEntry = entry;
  await flushPromises();
  return ui;
}

const dialogText = () => withoutIsolates(overlay().text());

async function fill(recipients: string, note = '') {
  const [to, text] = overlay().findAll('input, textarea');
  await to?.setValue(recipients);
  if (note) await text?.setValue(note);
  // The combobox adds pasted addresses one tick apart.
  await flushPromises();
}

async function chooseTab(label: string) {
  const tab = overlay()
    .findAll('.v-tab')
    .find((candidate) => candidate.text() === label);
  await tab?.trigger('click');
  await flushPromises();
}

const shareButton = () =>
  overlay()
    .findAll('button')
    .find((button) => button.text() === t('email.shareFromDevice'));

async function submit() {
  await overlay().get('form').trigger('submit');
  await flushPromises();
}

const shareLink = vi.spyOn(bridge, 'shareLink');

beforeEach(() => {
  api.entries.email.mockReset().mockResolvedValue();
  shareLink.mockReset().mockResolvedValue(true);
  localStorage.clear();
});

describe('EmailDialog', () => {
  it('sends the article to the addresses typed, with the note', async () => {
    const ui = await opened();
    expect(dialogText()).toContain(
      withoutIsolates(t('email.replyHint', { email: 'ann@example.com' })),
    );
    await fill('bo@example.com, cy@example.com', 'Look at this');
    await submit();
    expect(api.entries.email).toHaveBeenCalledWith(7, {
      to: ['bo@example.com', 'cy@example.com'],
      include: 'content',
      note: 'Look at this',
    });
    expect(ui.emailEntry).toBeNull();
    expect(withoutIsolates(ui.notice?.text ?? '')).toBe(
      withoutIsolates(t('email.articleSent', { n: 2 }, 2)),
    );
  });

  it('sends a link instead, where the article has one', async () => {
    await opened();
    await overlay().get('input[value="link"]').setValue(true);
    await fill('bo@example.com');
    await submit();
    expect(api.entries.email).toHaveBeenCalledWith(7, { to: ['bo@example.com'], include: 'link' });
  });

  it('offers only the whole article without a link', async () => {
    await opened({ entry: { ...ENTRY, link: null } });
    expect(overlay().find('input[value="link"]').exists()).toBe(false);
  });

  it('refuses an address that is not one', async () => {
    await opened();
    await fill('bo@example');
    expect(dialogText()).toContain(
      withoutIsolates(t('email.invalidAddress', { address: 'bo@example' })),
    );
    await submit();
    expect(api.entries.email).not.toHaveBeenCalled();
  });

  it('refuses more than five addresses', async () => {
    await opened();
    await fill('a@x.io b@x.io c@x.io d@x.io e@x.io f@x.io');
    expect(dialogText()).toContain(t('email.tooManyRecipients', { n: 5 }));
    await submit();
    expect(api.entries.email).not.toHaveBeenCalled();
  });

  it('keeps the dialog open and says why sending failed', async () => {
    api.entries.email.mockRejectedValue(new ApiError(502, 'mail_failed', 'failed', null));
    const ui = await opened();
    await fill('bo@example.com');
    await submit();
    expect(ui.emailEntry).not.toBeNull();
    expect(ui.notice).toEqual({ text: t('errors.code.mail_failed'), error: true });
  });

  it('points to Account settings without a confirmed address', async () => {
    await opened({ email: null });
    await chooseTab(t('email.viaServer'));
    expect(dialogText()).toContain(t('email.needsAddress'));
    const link = overlay()
      .findAll('a')
      .find((a) => a.text() === t('email.openAccount'));
    expect(link?.attributes('href')).toBe('/settings/account');
  });

  it('shares from the device only where the server cannot send email', async () => {
    const ui = await opened({ mail: false });
    expect(overlay().find('.v-tab').exists()).toBe(false);
    expect(overlay().find('form').exists()).toBe(false);
    expect(dialogText()).toContain(t('email.deviceHint'));
    await shareButton()?.trigger('click');
    await flushPromises();
    expect(shareLink).toHaveBeenCalledWith({
      title: 'Big story',
      text: '',
      url: 'https://news.example/a',
    });
    expect(ui.emailEntry).toBeNull();
  });

  it('starts on the device without a confirmed address', async () => {
    await opened({ email: null });
    expect(dialogText()).toContain(t('email.deviceHint'));
  });

  it('remembers the choice on this device', async () => {
    const ui = await opened();
    expect(overlay().find('form').exists()).toBe(true);
    await chooseTab(t('email.viaDevice'));
    expect(overlay().find('form').exists()).toBe(false);
    expect(localStorage.getItem('newses.emailVia')).toBe('device');
    ui.emailEntry = null;
    await flushPromises();
    ui.emailEntry = ENTRY;
    await flushPromises();
    expect(dialogText()).toContain(t('email.deviceHint'));
  });

  it('adds the public link to the original, or shares that alone', async () => {
    const ui = await opened({ mail: false, entry: { ...ENTRY, shareId: SHARE_ID } });
    await shareButton()?.trigger('click');
    expect(shareLink).toHaveBeenLastCalledWith({
      title: 'Big story',
      text: withoutIsolates(t('email.sharedCopy', { url: shareUrl(SHARE_ID) })),
      url: 'https://news.example/a',
    });
    await flushPromises();
    ui.emailEntry = { ...ENTRY, link: null, shareId: SHARE_ID };
    await flushPromises();
    await shareButton()?.trigger('click');
    expect(shareLink).toHaveBeenLastCalledWith({
      title: 'Big story',
      text: '',
      url: shareUrl(SHARE_ID),
    });
  });

  it('has nothing to share from the device without a web address or public link', async () => {
    await opened({ mail: false, entry: { ...ENTRY, link: null } });
    expect(dialogText()).toContain(t('email.deviceNeedsLink'));
    expect(shareButton()?.attributes('disabled')).toBeDefined();
  });

  it('stays open when the share sheet is dismissed', async () => {
    shareLink.mockResolvedValue(false);
    const ui = await opened({ mail: false });
    await shareButton()?.trigger('click');
    await flushPromises();
    expect(shareLink).toHaveBeenCalledOnce();
    expect(ui.emailEntry).not.toBeNull();
  });
});
