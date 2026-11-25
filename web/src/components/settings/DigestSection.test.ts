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
  account: { testDigest: vi.fn<() => Promise<void>>(), previewTestDigest: vi.fn() },
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
    expect(section.text()).not.toContain(t('email.digest.sendTest'));
  });

  it('previews a test digest with its costs, then sends it, with digests off', async () => {
    api.account.previewTestDigest.mockResolvedValue({
      articles: 1861,
      plugins: [
        {
          pluginId: 'digest-summary',
          name: 'Digest summary',
          estimate: { tokens: 175_000, costUsd: 0.7, note: 'With claude-opus-5-5 at low effort.' },
          failure: null,
        },
        { pluginId: 'tags', name: 'Tags', estimate: null, failure: 'none' },
      ],
    });
    api.account.testDigest.mockResolvedValueOnce(undefined);
    const section = await mounted();
    expect(section.text()).toContain(t('email.digest.testHint'));
    const button = (label: string) => section.findAll('button').find((b) => b.text() === label);
    await button(t('email.digest.sendTest'))?.trigger('click');
    await flushPromises();
    const text = section.text();
    expect(text).toContain(t('testDigest.articles', { n: '1,861' }, 1861));
    expect(text).toContain(t('testDigest.tokensAndCost', { tokens: '175,000', cost: '$0.70' }));
    expect(text).toContain('With claude-opus-5-5 at low effort.');
    expect(text).toContain(`Tags${t('testDigest.separator')}${t('testDigest.failure.none')}`);
    expect(api.account.testDigest).not.toHaveBeenCalled();

    // Cancel sends nothing; Send it sends.
    await button(t('testDigest.cancel'))?.trigger('click');
    expect(section.text()).not.toContain(t('testDigest.send'));
    await button(t('email.digest.sendTest'))?.trigger('click');
    await flushPromises();
    await button(t('testDigest.send'))?.trigger('click');
    await flushPromises();
    expect(api.account.testDigest).toHaveBeenCalledOnce();
    expect(section.text()).toContain(t('email.digest.testQueued'));
    expect(update).not.toHaveBeenCalled();
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
