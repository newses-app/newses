import { ApiError } from '@newses/shared/client';
import { QueryClient } from '@tanstack/vue-query';
import { enableAutoUnmount, flushPromises, type VueWrapper } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SESSION_KEY } from '../../composables/useSession.ts';
import { withoutIsolates } from '../../lib/message-params.ts';
import { i18n } from '../../plugins/i18n.ts';
import { useUiStore } from '../../stores/ui.ts';
import { button, mountInApp, testRouter } from '../../test/mount.ts';
import EmailSection from './EmailSection.vue';

const api = vi.hoisted(() => ({
  serverInfo: vi.fn<() => Promise<object>>(),
  auth: { session: vi.fn<() => Promise<object>>() },
  account: {
    setEmail: vi.fn<(email: string) => Promise<object>>(),
    removeEmail: vi.fn<() => Promise<void>>(),
  },
}));
vi.mock('../../api.ts', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  api,
}));

enableAutoUnmount(afterEach);
const { t } = i18n.global;

const USER = { id: 1, login: 'ann', role: 'user', email: null, pendingEmail: null };

async function mounted(user: object = {}, mail = true) {
  api.serverInfo.mockResolvedValue({ product: 'newses', mail });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const session = { user: { ...USER, ...user }, csrfToken: 'csrf', iconsPath: '/feed-icons/x' };
  queryClient.setQueryData(SESSION_KEY, session);
  api.auth.session.mockResolvedValue(session);
  const { wrapper, pinia } = mountInApp(EmailSection, {
    queryClient,
    router: await testRouter('/settings/account'),
  });
  await flushPromises();
  return { section: wrapper, ui: useUiStore(pinia), queryClient };
}

const text = (wrapper: VueWrapper) => withoutIsolates(wrapper.text());

async function submit(section: VueWrapper, address: string) {
  await section.get('input').setValue(address);
  await section.get('form').trigger('submit');
  await flushPromises();
}

beforeEach(() => {
  api.account.setEmail.mockReset();
  api.account.removeEmail.mockReset().mockResolvedValue();
});

describe('EmailSection', () => {
  it('is hidden where the server cannot mail users', async () => {
    const { section } = await mounted({}, false);
    expect(section.text()).toBe('');
  });

  it('mails a link and shows the address as pending', async () => {
    const { section, ui } = await mounted();
    api.account.setEmail.mockResolvedValue({ ...USER, pendingEmail: 'ann@example.com' });
    await submit(section, 'ann@example.com');
    expect(api.account.setEmail).toHaveBeenCalledWith('ann@example.com');
    expect(withoutIsolates(ui.notice?.text ?? '')).toBe(
      withoutIsolates(t('email.sent', { email: 'ann@example.com' })),
    );
    expect(text(section)).toContain('ann@example.com');
    expect(text(section)).toContain(t('email.pending'));
    expect(section.get('input').element.value).toBe('');
  });

  it('resends the link, and cancels it keeping the confirmed address', async () => {
    const { section } = await mounted({
      email: 'ann@example.com',
      pendingEmail: 'new@example.com',
    });
    expect(text(section)).toContain(t('email.confirmed'));
    api.account.setEmail.mockResolvedValue({
      ...USER,
      email: 'ann@example.com',
      pendingEmail: 'new@example.com',
    });
    await section
      .get(`[aria-label="${t('email.resendNamed', { email: 'new@example.com' })}"]`)
      .trigger('click');
    await flushPromises();
    expect(api.account.setEmail).toHaveBeenLastCalledWith('new@example.com');

    api.account.setEmail.mockResolvedValue({ ...USER, email: 'ann@example.com' });
    await button(section, t('common.cancel')).trigger('click');
    await flushPromises();
    expect(api.account.setEmail).toHaveBeenLastCalledWith('ann@example.com');
    expect(text(section)).not.toContain('new@example.com');
    expect(api.account.removeEmail).not.toHaveBeenCalled();
  });

  it('cancels a pending address when there is no confirmed one', async () => {
    const { section } = await mounted({ pendingEmail: 'new@example.com' });
    await button(section, t('common.cancel')).trigger('click');
    await flushPromises();
    expect(api.account.removeEmail).toHaveBeenCalled();
    expect(text(section)).not.toContain('new@example.com');
  });

  it('removes the address once confirmed', async () => {
    const { section, ui } = await mounted({ email: 'ann@example.com' });
    const remove = section.get(
      `[aria-label="${t('email.removeNamed', { email: 'ann@example.com' })}"]`,
    );
    await remove.trigger('click');
    ui.confirmRequest?.resolve(false);
    await flushPromises();
    expect(api.account.removeEmail).not.toHaveBeenCalled();
    await remove.trigger('click');
    ui.confirmRequest?.resolve(true);
    await flushPromises();
    expect(api.account.removeEmail).toHaveBeenCalled();
    expect(text(section)).not.toContain('ann@example.com');
  });

  it('says why an address was refused', async () => {
    const { section, ui } = await mounted();
    api.account.setEmail.mockRejectedValue(new ApiError(429, 'throttled', 'Too many requests', 30));
    await submit(section, 'ann@example.com');
    expect(ui.notice).toEqual({ text: t('errors.code.throttled'), error: true });
    expect(text(section)).not.toContain(t('email.pending'));
  });
});
