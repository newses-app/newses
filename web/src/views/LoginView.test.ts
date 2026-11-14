import { ApiError } from '@newses/shared/client';
import { enableAutoUnmount, flushPromises, type VueWrapper } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Router } from 'vue-router';
import { withoutIsolates } from '../lib/message-params.ts';
import { i18n } from '../plugins/i18n.ts';
import { inLayout, mountInApp, testRouter } from '../test/mount.ts';
import LoginView from './LoginView.vue';

const session = vi.hoisted(() => ({
  login: vi.fn<(name: string, password: string) => Promise<string | null>>(),
  completeLogin: vi.fn<(challenge: string, code: string) => Promise<void>>(),
}));
vi.mock('../composables/useSession.ts', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useSession: () => session,
}));

enableAutoUnmount(afterEach);
const { t } = i18n.global;

let router: Router;

async function open(path = '/login') {
  router = await testRouter(path, ['login', 'connect', 'about']);
  const { wrapper } = mountInApp(inLayout(LoginView), { router });
  await flushPromises();
  return wrapper;
}

async function signIn(view: VueWrapper, name = ' ann ', password = 'secret') {
  const [nameField, passwordField] = view.findAll('input');
  await nameField?.setValue(name);
  await passwordField?.setValue(password);
  await view.get('form').trigger('submit');
  await flushPromises();
}

async function enterCode(view: VueWrapper, code: string) {
  await view.get('input').setValue(code);
  await view.get('form').trigger('submit');
  await flushPromises();
}

const error = (view: VueWrapper) =>
  view.find('.v-alert').exists() ? withoutIsolates(view.get('.v-alert').text()) : null;

beforeEach(() => {
  session.login.mockReset().mockResolvedValue(null);
  session.completeLogin.mockReset().mockResolvedValue();
});

describe('LoginView', () => {
  it('signs in, then goes where the reader was going', async () => {
    const view = await open('/login?redirect=/c/2%3Funread%3D1');
    await signIn(view);
    expect(session.login).toHaveBeenCalledWith('ann', 'secret');
    expect(router.currentRoute.value.fullPath).toBe('/c/2?unread=1');
  });

  it('only goes to paths in the app after signing in', async () => {
    for (const redirect of ['//evil.example/', 'https://evil.example/']) {
      const view = await open(`/login?redirect=${encodeURIComponent(redirect)}`);
      await signIn(view);
      expect(router.currentRoute.value.fullPath).toBe('/all');
    }
  });

  it('asks for an authentication code when the account has two-factor sign-in', async () => {
    session.login.mockResolvedValue('challenge-1');
    const view = await open();
    await signIn(view);
    expect(view.text()).toContain(t('login.codePrompt'));
    expect(view.get('input').attributes('autocomplete')).toBe('one-time-code');

    session.completeLogin.mockRejectedValueOnce(new ApiError(401, 'invalid', 'x', null));
    await enterCode(view, ' 123456 ');
    expect(session.completeLogin).toHaveBeenCalledWith('challenge-1', '123456');
    expect(error(view)).toBe(t('login.invalidCode'));

    await enterCode(view, '654321');
    expect(router.currentRoute.value.fullPath).toBe('/all');
  });

  it('starts over when the code came too late, or when asked', async () => {
    session.login.mockResolvedValue('challenge-1');
    const view = await open();
    await signIn(view);
    session.completeLogin.mockRejectedValueOnce(new ApiError(400, 'expired', 'x', null));
    await enterCode(view, '123456');
    expect(error(view)).toBe(t('login.expired'));
    expect(view.findAll('input')).toHaveLength(2);

    await signIn(view);
    const startOver = view.findAll('button').find((b) => b.text() === t('login.startOver'));
    await startOver?.trigger('click');
    // The name stays as typed; only the password is cleared.
    expect(view.findAll('input').map((input) => input.element.value)).toEqual([' ann ', '']);
  });

  it.each([
    [new ApiError(429, 'throttled', 'x', 30), t('login.throttled', { seconds: 30 })],
    [new ApiError(429, 'throttled', 'x', null), t('login.throttled', { seconds: 60 })],
    [new ApiError(403, 'password_expired', 'x', null), t('login.passwordExpired')],
    [new ApiError(401, 'invalid', 'x', null), t('login.invalid')],
    [new TypeError('Failed to fetch'), t('errors.generic')],
  ])('explains a refused sign-in: %s', async (refusal, message) => {
    session.login.mockRejectedValue(refusal);
    const view = await open();
    await signIn(view);
    expect(error(view)).toBe(withoutIsolates(message));
    expect(router.currentRoute.value.path).toBe('/login');
  });

  it('can only be sent filled in', async () => {
    const view = await open();
    const submit = () => view.get('button[type="submit"]');
    expect(submit().attributes('disabled')).toBeDefined();
    const [nameField, passwordField] = view.findAll('input');
    await nameField?.setValue('ann');
    await passwordField?.setValue('secret');
    expect(submit().attributes('disabled')).toBeUndefined();
  });
});
