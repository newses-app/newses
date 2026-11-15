import { ApiError } from '@newses/shared/client';
import { enableAutoUnmount, flushPromises } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { withoutIsolates } from '../lib/message-params.ts';
import { i18n } from '../plugins/i18n.ts';
import { button, inLayout, mountInApp, testRouter } from '../test/mount.ts';
import ConfirmEmailView from './ConfirmEmailView.vue';

const api = vi.hoisted(() => ({
  auth: { session: vi.fn<() => Promise<object>>() },
  account: { confirmEmail: vi.fn<(token: string) => Promise<object>>() },
}));
vi.mock('../api.ts', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  api,
}));

enableAutoUnmount(afterEach);
const { t } = i18n.global;

async function open(path: string) {
  const router = await testRouter(path);
  const { wrapper } = mountInApp(inLayout(ConfirmEmailView), { router });
  await flushPromises();
  return wrapper;
}

const text = (wrapper: { text(): string }) => withoutIsolates(wrapper.text());

beforeEach(() => {
  api.auth.session.mockReset().mockRejectedValue(new ApiError(401, 'unauthenticated', '', null));
  api.account.confirmEmail.mockReset().mockResolvedValue({ email: 'ann@example.com' });
});

describe('ConfirmEmailView', () => {
  it('confirms only once the button is pressed, with the token from the fragment', async () => {
    const view = await open('/confirm-email#token-123');
    expect(api.account.confirmEmail).not.toHaveBeenCalled();
    await button(view, t('email.confirmAction')).trigger('click');
    await flushPromises();
    expect(api.account.confirmEmail).toHaveBeenCalledWith('token-123');
    expect(text(view)).toContain(
      withoutIsolates(t('email.confirmedText', { email: 'ann@example.com' })),
    );
    expect(view.find('a').attributes('href')).toBe('/all');
  });

  it('says when the link has expired', async () => {
    api.account.confirmEmail.mockRejectedValue(
      new ApiError(400, 'invalid_input', 'expired', null, { reason: 'email_link_invalid' }),
    );
    const view = await open('/confirm-email#old');
    await button(view, t('email.confirmAction')).trigger('click');
    await flushPromises();
    expect(text(view)).toContain(t('errors.reason.email_link_invalid'));
  });

  it('offers nothing to confirm without a token', async () => {
    const view = await open('/confirm-email');
    expect(text(view)).toContain(t('errors.reason.email_link_invalid'));
    expect(view.findAll('button').map((b) => b.text())).not.toContain(t('email.confirmAction'));
  });
});
