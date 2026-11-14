import { ApiError } from '@newses/shared/client';
import { enableAutoUnmount, flushPromises } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { i18n } from '../../plugins/i18n.ts';
import { mountInApp } from '../../test/mount.ts';
import PasswordForm from './PasswordForm.vue';

const changePassword = vi.hoisted(() => vi.fn<(body: object) => Promise<void>>());
vi.mock('../../api.ts', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  api: { auth: { changePassword } },
}));

enableAutoUnmount(afterEach);
const { t } = i18n.global;

async function submit(current: string, next: string, repeat = next) {
  const { wrapper } = mountInApp(PasswordForm);
  const [first, second, third] = wrapper.findAll('input');
  await first?.setValue(current);
  await second?.setValue(next);
  await third?.setValue(repeat);
  await wrapper.get('form').trigger('submit');
  await flushPromises();
  return wrapper;
}

const error = (wrapper: Awaited<ReturnType<typeof submit>>) =>
  wrapper.find('.v-alert').exists() ? wrapper.get('.v-alert').text() : null;

beforeEach(() => {
  changePassword.mockReset();
  changePassword.mockResolvedValue();
});

describe('PasswordForm', () => {
  it('changes the password, clears the fields, and says so', async () => {
    const form = await submit('old password', 'new password');
    expect(changePassword).toHaveBeenCalledWith({
      currentPassword: 'old password',
      newPassword: 'new password',
    });
    expect(form.emitted('changed')).toHaveLength(1);
    expect(form.findAll('input').map((input) => input.element.value)).toEqual(['', '', '']);
    expect(error(form)).toBeNull();
  });

  it('checks the new password before sending it', async () => {
    expect(error(await submit('old password', 'short'))).toBe(t('account.tooShort'));
    expect(error(await submit('old password', 'new password', 'other password'))).toBe(
      t('account.mismatch'),
    );
    expect(changePassword).not.toHaveBeenCalled();
  });

  it.each([
    [401, 'account.wrongPassword'],
    [400, 'account.tooCommon'],
    [429, 'account.throttled'],
    [500, 'errors.generic'],
  ])('explains a refusal with status %i', async (status, key) => {
    changePassword.mockRejectedValue(new ApiError(status, 'x', 'x', null));
    const form = await submit('old password', 'new password');
    expect(error(form)).toBe(t(key));
    expect(form.emitted('changed')).toBeUndefined();
  });

  it('can only be sent with the current and new passwords filled in', async () => {
    const { wrapper } = mountInApp(PasswordForm);
    expect(wrapper.get('button[type="submit"]').attributes('disabled')).toBeDefined();
    const [first, second] = wrapper.findAll('input');
    await first?.setValue('old');
    await second?.setValue('new');
    expect(wrapper.get('button[type="submit"]').attributes('disabled')).toBeUndefined();
  });
});
