import { ApiError } from '@newses/shared/client';
import { enableAutoUnmount, flushPromises, type VueWrapper } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ref } from 'vue';
import { withoutIsolates } from '../../lib/message-params.ts';
import { i18n } from '../../plugins/i18n.ts';
import { useUiStore } from '../../stores/ui.ts';
import { button, mountInApp, overlay } from '../../test/mount.ts';
import AppPasswordsSection from './AppPasswordsSection.vue';

const appPasswords = vi.hoisted(() => ({
  list: vi.fn<() => Promise<object[]>>(),
  connection: vi.fn<() => Promise<object>>(),
  create: vi.fn<(body: object) => Promise<object>>(),
  revoke: vi.fn<(id: number) => Promise<void>>(),
}));
vi.mock('../../api.ts', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  api: { auth: { appPasswords } },
}));
vi.mock('../../composables/useSession.ts', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useSession: () => ({ session: ref({ user: { login: 'ann' } }) }),
}));

enableAutoUnmount(afterEach);
const { t } = i18n.global;

const SERVER = 'https://reader.example';
let clipboard: string[];

async function mounted() {
  const { wrapper, pinia } = mountInApp(AppPasswordsSection);
  await flushPromises();
  return { section: wrapper, ui: useUiStore(pinia) };
}

async function create(section: VueWrapper, name: string, password: string) {
  await button(section, t('appPasswords.create')).trigger('click');
  await flushPromises();
  const [nameField, passwordField] = overlay().findAll('input');
  await nameField?.setValue(name);
  await passwordField?.setValue(password);
  await overlay().get('form').trigger('submit');
  await flushPromises();
}

const alert = () => document.querySelector('.v-dialog .v-alert')?.textContent.trim() ?? null;
const text = (wrapper: { text(): string }) => withoutIsolates(wrapper.text());

beforeEach(() => {
  for (const fn of Object.values(appPasswords)) fn.mockReset();
  appPasswords.list.mockResolvedValue([
    { id: 1, name: 'Phone', lastUsedAt: null },
    { id: 2, name: 'Tablet', lastUsedAt: new Date(Date.now() - 3_600_000).toISOString() },
  ]);
  appPasswords.connection.mockResolvedValue({ serverUrl: SERVER, syncIntervalMinutes: 15 });
  appPasswords.create.mockResolvedValue({ appPassword: { name: 'Laptop' }, password: 'abcd-efgh' });
  appPasswords.revoke.mockResolvedValue();
  clipboard = [];
  Object.defineProperty(navigator, 'clipboard', {
    value: {
      writeText: (value: string) => {
        clipboard.push(value);
        return Promise.resolve();
      },
    },
    configurable: true,
  });
});

afterEach(() => {
  Reflect.deleteProperty(navigator, 'clipboard');
});

describe('AppPasswordsSection', () => {
  it('lists app passwords with when each was last used', async () => {
    const { section } = await mounted();
    expect(text(section)).toContain('Phone');
    expect(text(section)).toContain(t('appPasswords.neverUsed'));
    expect(text(section)).toContain('Tablet');
  });

  it('says when there are none', async () => {
    appPasswords.list.mockResolvedValue([]);
    const { section } = await mounted();
    expect(section.text()).toContain(t('appPasswords.none'));
  });

  it('shows what to type into each kind of app, each copied with a click', async () => {
    const { section, ui } = await mounted();
    const value = (key: string) =>
      section.get(`[data-connection="${key}"] .connection-value`).text();
    expect(['ttrss', 'greader', 'freshrss', 'login'].map(value)).toEqual([
      `${SERVER}/`,
      SERVER,
      `${SERVER}/api/greader.php`,
      'ann',
    ]);
    expect(text(section)).toContain(
      withoutIsolates(t('appPasswords.syncInterval', { minutes: 15 })),
    );
    await section.get('[data-connection="freshrss"] button').trigger('click');
    await flushPromises();
    expect(clipboard).toEqual([`${SERVER}/api/greader.php`]);
    expect(ui.notice?.text).toBe(t('appPasswords.copiedValue'));
  });

  it('creates an app password, showing it once to copy', async () => {
    const { section, ui } = await mounted();
    await create(section, ' Laptop ', 'secret');
    expect(appPasswords.create).toHaveBeenCalledWith({ name: 'Laptop', password: 'secret' });
    expect(overlay().get('code').text()).toBe('abcd-efgh');
    await button(overlay(), t('twoFactor.copy')).trigger('click');
    await flushPromises();
    expect(clipboard).toEqual(['abcd-efgh']);
    expect(ui.notice?.text).toBe(t('appPasswords.copied'));
    expect(appPasswords.list).toHaveBeenCalledTimes(2);

    await overlay().get('form').trigger('submit');
    await flushPromises();
    expect(document.querySelector('.v-dialog .v-card')).toBeNull();
  });

  it.each([
    [new ApiError(401, 'x', 'x', null), 'account.wrongPassword'],
    [new ApiError(429, 'x', 'x', null), 'account.throttled'],
    [new TypeError('Failed to fetch'), 'errors.generic'],
  ])('explains a refused app password: %s', async (refusal, key) => {
    appPasswords.create.mockRejectedValue(refusal);
    const { section } = await mounted();
    await create(section, 'Laptop', 'wrong');
    expect(alert()).toBe(t(key));
  });

  it('revokes an app password once confirmed', async () => {
    const { section, ui } = await mounted();
    const remove = () =>
      section
        .findAll('button')
        .find((b) => withoutIsolates(b.attributes('aria-label') ?? '').endsWith('Phone'));
    await remove()?.trigger('click');
    expect(ui.confirmRequest?.text).toContain('Phone');
    ui.confirmRequest?.resolve(false);
    await flushPromises();
    expect(appPasswords.revoke).not.toHaveBeenCalled();

    appPasswords.revoke.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    await remove()?.trigger('click');
    ui.confirmRequest?.resolve(true);
    await flushPromises();
    expect(appPasswords.revoke).toHaveBeenCalledWith(1);
    expect(ui.notice).toEqual({ text: t('errors.generic'), error: true });
  });

  it('says when copying fails', async () => {
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: () => Promise.reject(new Error('denied')) },
      configurable: true,
    });
    const { section, ui } = await mounted();
    await section.get('[data-connection="login"] button').trigger('click');
    await flushPromises();
    expect(ui.notice?.error).toBe(true);
  });
});
