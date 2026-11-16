import type { Prefs, UpdatePrefsRequest } from '@newses/shared';
import { DEFAULT_PREFS, localTimeZone } from '@newses/shared/client';
import { QueryClient } from '@tanstack/vue-query';
import { enableAutoUnmount, flushPromises } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { computed, ref } from 'vue';
import { VSelect } from 'vuetify/components';
import { SESSION_KEY } from '../../composables/useSession.ts';
import { i18n } from '../../plugins/i18n.ts';
import { mountInApp, testRouter } from '../../test/mount.ts';
import DigestSection from './DigestSection.vue';

const api = vi.hoisted(() => ({
  serverInfo: vi.fn<() => Promise<object>>(),
  auth: { session: vi.fn<() => Promise<object>>() },
}));
vi.mock('../../api.ts', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  api,
}));

const prefs = ref<Prefs>({ ...DEFAULT_PREFS });
const update = vi.fn((changes: UpdatePrefsRequest) => {
  prefs.value = { ...prefs.value, ...changes } as Prefs;
});
vi.mock('../../composables/usePrefs.ts', () => ({
  usePrefs: () => ({ prefs: computed(() => prefs.value), loaded: computed(() => true), update }),
}));

enableAutoUnmount(afterEach);
const { t } = i18n.global;

async function mounted({
  digest = true,
  email = 'ann@example.com',
}: { digest?: boolean; email?: string | null } = {}) {
  api.serverInfo.mockResolvedValue({ product: 'newses', mail: true, digest });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const session = {
    user: { id: 1, login: 'ann', role: 'user', email, pendingEmail: null },
    csrfToken: 'csrf',
    iconsPath: '/feed-icons/x',
  };
  queryClient.setQueryData(SESSION_KEY, session);
  api.auth.session.mockResolvedValue(session);
  const { wrapper } = mountInApp(DigestSection, {
    queryClient,
    router: await testRouter('/settings/account'),
  });
  await flushPromises();
  return wrapper;
}

beforeEach(() => {
  prefs.value = { ...DEFAULT_PREFS };
  update.mockClear();
});

describe('DigestSection', () => {
  it('is hidden where the server sends no digests', async () => {
    expect((await mounted({ digest: false })).text()).toBe('');
  });

  it('waits for a confirmed address', async () => {
    const section = await mounted({ email: null });
    expect(section.text()).toContain(t('email.digest.needsAddress'));
    expect(section.find('.v-select').classes()).toContain('v-input--disabled');
  });

  it("turns digests on in the device's time zone, then offers the time and day", async () => {
    const section = await mounted();
    expect(section.text()).toContain(t('email.digest.hint'));
    expect(section.findAll('.v-select')).toHaveLength(1);
    section.getComponent(VSelect).vm.$emit('update:modelValue', 'weekly');
    await flushPromises();
    expect(update).toHaveBeenCalledWith({ digestFrequency: 'weekly', timeZone: localTimeZone() });
    // Frequency, day, and time; the time zone; marking read.
    expect(section.findAll('.v-select')).toHaveLength(3);
    expect(section.find('.v-autocomplete').exists()).toBe(true);
    expect(section.text()).toContain(t('email.digest.markRead'));

    update.mockClear();
    section.getComponent(VSelect).vm.$emit('update:modelValue', 'daily');
    await flushPromises();
    // A time zone already chosen stays.
    expect(update).toHaveBeenCalledWith({ digestFrequency: 'daily' });
    expect(section.findAll('.v-select')).toHaveLength(2);
  });
});
