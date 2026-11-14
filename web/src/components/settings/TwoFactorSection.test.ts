import { ApiError } from '@newses/shared/client';
import { enableAutoUnmount, flushPromises, type VueWrapper } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { withoutIsolates } from '../../lib/message-params.ts';
import { i18n } from '../../plugins/i18n.ts';
import { useUiStore } from '../../stores/ui.ts';
import { button, mountInApp, overlay } from '../../test/mount.ts';
import { spyInvalidations } from '../../test/queries.ts';
import TwoFactorSection from './TwoFactorSection.vue';

const twoFactor = vi.hoisted(() => ({
  status: vi.fn<() => Promise<object>>(),
  setup: vi.fn<(password: string) => Promise<object>>(),
  enable: vi.fn<(code: string) => Promise<object>>(),
  disable: vi.fn<(password: string, code: string) => Promise<void>>(),
  regenerateRecoveryCodes: vi.fn<(code: string) => Promise<object>>(),
}));
vi.mock('../../api.ts', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  api: { auth: { twoFactor } },
}));
vi.mock('qrcode', () => ({ default: { toDataURL: () => Promise.resolve('data:image/png;qr') } }));

enableAutoUnmount(afterEach);
const { t } = i18n.global;

const CODES = ['aaaa-1111', 'bbbb-2222'];

async function mounted(enabled: boolean) {
  twoFactor.status.mockResolvedValue({ enabled, recoveryCodesLeft: 8 });
  const { wrapper, pinia, queryClient } = mountInApp(TwoFactorSection);
  await flushPromises();
  return { section: wrapper, ui: useUiStore(pinia), invalidations: spyInvalidations(queryClient) };
}

async function start(section: VueWrapper, label: string) {
  await button(section, label).trigger('click');
  await flushPromises();
}

/** Fills the dialog's fields in order, then sends it. */
async function send(...values: string[]) {
  const inputs = overlay().findAll('input');
  for (const [i, value] of values.entries()) await inputs[i]?.setValue(value);
  await overlay().get('form').trigger('submit');
  await flushPromises();
}

const alert = () => document.querySelector('.v-dialog .v-alert')?.textContent.trim() ?? null;
// The card shows only while a step is open; the overlay stays a moment as it leaves.
const open = () => document.querySelector('.v-dialog .v-card') !== null;

beforeEach(() => {
  for (const fn of Object.values(twoFactor)) fn.mockReset();
  twoFactor.setup.mockResolvedValue({ secret: 'JBSWY3DP', uri: 'otpauth://totp/x' });
  twoFactor.enable.mockResolvedValue({ recoveryCodes: CODES });
  twoFactor.disable.mockResolvedValue();
  twoFactor.regenerateRecoveryCodes.mockResolvedValue({ recoveryCodes: CODES });
});

describe('TwoFactorSection', () => {
  it('sets up two-factor sign-in: password, scan, code, then recovery codes', async () => {
    const { section, ui, invalidations } = await mounted(false);
    expect(section.text()).toContain(t('twoFactor.offSummary'));
    await start(section, t('twoFactor.setUp'));
    await send('secret');
    expect(twoFactor.setup).toHaveBeenCalledWith('secret');
    expect(overlay().get('img').attributes('src')).toBe('data:image/png;qr');
    expect(overlay().text()).toContain('JBSWY3DP');

    await send(' 123456 ');
    expect(twoFactor.enable).toHaveBeenCalledWith('123456');
    expect(
      overlay()
        .findAll('li')
        .map((li) => li.text()),
    ).toEqual(CODES);
    expect(ui.notice?.text).toBe(t('twoFactor.enabled'));
    expect(invalidations.keys()).toContainEqual(['sessions']);

    await button(overlay(), t('twoFactor.savedCodes')).trigger('click');
    await flushPromises();
    expect(open()).toBe(false);
  });

  it.each([
    [401, 'account.wrongPassword'],
    [429, 'account.throttled'],
    [500, 'errors.generic'],
  ])('explains a refused password (%i)', async (status, key) => {
    twoFactor.setup.mockRejectedValue(new ApiError(status, 'x', 'x', null));
    const { section } = await mounted(false);
    await start(section, t('twoFactor.setUp'));
    await send('wrong');
    expect(alert()).toBe(t(key));
  });

  it('refuses a wrong code while setting up', async () => {
    twoFactor.enable.mockRejectedValue(new ApiError(401, 'x', 'x', null));
    const { section } = await mounted(false);
    await start(section, t('twoFactor.setUp'));
    await send('secret');
    await send('000000');
    expect(alert()).toBe(t('login.invalidCode'));
  });

  it('copies and downloads the recovery codes', async () => {
    const writeText = vi.fn<(text: string) => Promise<void>>(() => Promise.resolve());
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    const createObjectURL = vi.fn(() => 'blob:codes');
    const revokeObjectURL = vi.fn();
    Object.assign(URL, { createObjectURL, revokeObjectURL });
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(() => undefined);

    const { section, ui } = await mounted(true);
    await start(section, t('twoFactor.newRecoveryCodes'));
    await send('123456');
    await button(overlay(), t('twoFactor.copy')).trigger('click');
    await flushPromises();
    expect(writeText).toHaveBeenCalledWith('aaaa-1111\nbbbb-2222');
    expect(ui.notice?.text).toBe(t('twoFactor.copied'));

    writeText.mockRejectedValue(new Error('denied'));
    await button(overlay(), t('twoFactor.copy')).trigger('click');
    await flushPromises();
    expect(ui.notice?.error).toBe(true);

    await button(overlay(), t('twoFactor.download')).trigger('click');
    expect(click).toHaveBeenCalledOnce();
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:codes');
    Reflect.deleteProperty(navigator, 'clipboard');
  });

  it('turns two-factor sign-in off with the password and a code', async () => {
    const { section, ui } = await mounted(true);
    expect(withoutIsolates(section.text())).toContain(
      withoutIsolates(t('twoFactor.onSummary', { count: 8 })),
    );
    twoFactor.disable.mockRejectedValueOnce(new ApiError(401, 'x', 'x', null));
    await start(section, t('twoFactor.disable'));
    await send('secret', '111111');
    expect(alert()).toBe(t('twoFactor.wrongPasswordOrCode'));
    await send('secret', ' 222222 ');
    expect(twoFactor.disable).toHaveBeenLastCalledWith('secret', '222222');
    expect(ui.notice?.text).toBe(t('twoFactor.disabled'));
    expect(open()).toBe(false);
  });

  it('refuses a wrong code for new recovery codes, and closes on cancel', async () => {
    twoFactor.regenerateRecoveryCodes.mockRejectedValue(new ApiError(401, 'x', 'x', null));
    const { section } = await mounted(true);
    await start(section, t('twoFactor.newRecoveryCodes'));
    await send('000000');
    expect(alert()).toBe(t('login.invalidCode'));
    await button(overlay(), t('common.cancel')).trigger('click');
    await flushPromises();
    expect(open()).toBe(false);
  });
});
