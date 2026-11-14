import { QueryClient } from '@tanstack/vue-query';
import { enableAutoUnmount, flushPromises } from '@vue/test-utils';
import { afterEach, describe, expect, it } from 'vitest';
import { nextTick } from 'vue';
import { SUBSCRIPTIONS_KEY } from '../../composables/useFeeds.ts';
import { SESSION_KEY } from '../../composables/useSession.ts';
import { mountInApp, testRouter } from '../../test/mount.ts';
import FeedIcon from './FeedIcon.vue';

enableAutoUnmount(afterEach);

async function icon(subscriptionId: number | null, size?: number) {
  const queryClient = new QueryClient();
  queryClient.setQueryData(SESSION_KEY, { user: { id: 1 }, csrfToken: null, iconsPath: '/i' });
  queryClient.setQueryData(SUBSCRIPTIONS_KEY, [
    { id: 1, iconUrl: 'https://a.example/favicon.ico' },
    { id: 2, iconUrl: null },
  ]);
  const { wrapper } = mountInApp(FeedIcon, {
    props: { subscriptionId, ...(size && { size }) },
    queryClient,
    router: await testRouter(),
  });
  await flushPromises();
  return wrapper;
}

describe('FeedIcon', () => {
  it("shows the subscription's icon at the size asked for", async () => {
    const img = (await icon(1, 24)).get('img');
    expect(img.attributes()).toMatchObject({
      src: 'https://a.example/favicon.ico',
      width: '24',
      alt: '',
      loading: 'lazy',
    });
  });

  it('shows the feed glyph without an icon, or once it fails to load', async () => {
    expect((await icon(2)).find('img').exists()).toBe(false);
    expect((await icon(null)).find('img').exists()).toBe(false);
    const failing = await icon(1);
    await failing.get('img').trigger('error');
    await nextTick();
    expect(failing.find('img').exists()).toBe(false);
    expect(failing.find('.v-icon').exists()).toBe(true);
  });
});
