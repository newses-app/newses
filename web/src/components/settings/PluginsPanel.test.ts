import type { Plugin, PluginsResponse, PluginSettingsState, Subscription } from '@newses/shared';
import { QueryClient } from '@tanstack/vue-query';
import { enableAutoUnmount, flushPromises } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { VAutocomplete, VCombobox, VSwitch } from 'vuetify/components';
import { SUBSCRIPTIONS_KEY } from '../../composables/useFeeds.ts';
import { SESSION_KEY } from '../../composables/useSession.ts';
import { i18n } from '../../plugins/i18n.ts';
import { mountInApp } from '../../test/mount.ts';
import PluginsPanel from './PluginsPanel.vue';

const api = vi.hoisted(() => ({
  plugins: { list: vi.fn<() => Promise<PluginsResponse>>() },
  subscriptions: { list: vi.fn() },
  admin: { plugins: { update: vi.fn(), remove: vi.fn(), test: vi.fn() } },
  account: {
    updatePlugin: vi.fn(),
    removePlugin: vi.fn(),
    testPlugin: vi.fn(),
    testDigest: vi.fn(),
  },
  serverInfo: vi.fn(() => Promise.resolve({ product: 'newses', mail: true, digest: true })),
}));
vi.mock('../../api.ts', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  api,
}));

enableAutoUnmount(afterEach);
const { t } = i18n.global;

const OFF: PluginSettingsState = {
  enabled: false,
  settings: {},
  secretsSet: [],
  failures: 0,
  lastFailure: null,
  lastFailureAt: null,
  disabledReason: null,
};

const summary: Plugin = {
  id: 'summary',
  version: '2.0.0',
  scopes: ['instance'],
  enabled: true,
  hosts: ['api.anthropic.com'],
  approvedHosts: ['api.anthropic.com'],
  messages: {
    en: {
      name: 'Digest summary',
      description: 'Sends unread titles to Anthropic.',
      'settings.apiKey': 'API key',
      'settings.model': 'Model',
    },
  },
  settingsSchemas: {
    instance: {
      type: 'object',
      properties: {
        apiKey: { type: 'string', newses: { secret: true } },
        model: { type: 'string', default: 'm' },
      },
      required: ['apiKey'],
    },
    user: null,
  },
  admin: {
    ...OFF,
    enabled: true,
    settings: { model: 'big' },
    secretsSet: ['apiKey'],
    failures: 10,
    lastFailure: 'timeout',
    disabledReason: 'failures',
    source: '@newses/plugin-summary@2.0.0',
  },
  user: null,
};

const webhook: Plugin = {
  id: 'webhook',
  version: '1.0.0',
  scopes: ['user'],
  enabled: true,
  hosts: [],
  approvedHosts: ['hooks.example'],
  messages: { en: { name: 'Webhook', 'settings.target': 'URL' } },
  settingsSchemas: {
    instance: null,
    user: {
      type: 'object',
      properties: { target: { type: 'string', format: 'uri', newses: { url: true } } },
      required: ['target'],
    },
  },
  admin: null,
  user: { ...OFF, enabled: true, settings: { target: 'https://hooks.example/a' } },
};

async function mounted(role: 'admin' | 'user', response: PluginsResponse) {
  api.plugins.list.mockResolvedValue(response);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  queryClient.setQueryData(SESSION_KEY, {
    user: { id: 1, login: 'ann', role, email: null, pendingEmail: null },
    csrfToken: 'csrf',
    iconsPath: '/feed-icons/x',
  });
  const feeds = [
    { id: 4, title: 'Tech', categoryId: null },
    { id: 9, title: 'Weather', categoryId: null },
  ] as Subscription[];
  queryClient.setQueryData<Subscription[]>(SUBSCRIPTIONS_KEY, feeds);
  api.subscriptions.list.mockResolvedValue(feeds);
  const { wrapper } = mountInApp(PluginsPanel, { queryClient });
  await flushPromises();
  return wrapper;
}

beforeEach(() => {
  vi.clearAllMocks();
  api.admin.plugins.update.mockResolvedValue(summary);
  api.account.updatePlugin.mockResolvedValue(webhook);
});

describe('PluginsPanel', () => {
  it('says when no plugins are installed, or none is on', async () => {
    expect((await mounted('admin', { plugins: [], uninstalled: [] })).text()).toContain(
      t('plugins.noneInstalled'),
    );
    expect((await mounted('user', { plugins: [], uninstalled: [] })).text()).toContain(
      t('plugins.noneOn'),
    );
  });

  it("shows admins a plugin's text, status, hosts, and instance form", async () => {
    const panel = await mounted('admin', { plugins: [summary], uninstalled: ['gone'] });
    const text = panel.text();
    expect(text).toContain('Digest summary');
    expect(text).toContain('Sends unread titles to Anthropic.');
    expect(text).toContain('@newses/plugin-summary@2.0.0');
    expect(text).toContain(t('plugins.experimental'));
    expect(text).toContain(
      t('plugins.turnedOff', { count: 10, failure: t('plugins.failure.timeout') }),
    );
    expect(text).toContain(t('plugins.secretSet'));
    expect(text).toContain('gone');
    expect(panel.find('input[type="password"]').exists()).toBe(true);
    expect((panel.find('input[type="text"][value="big"]').element as HTMLInputElement).value).toBe(
      'big',
    );

    panel.getComponent(VSwitch).vm.$emit('update:modelValue', false);
    await flushPromises();
    expect(api.admin.plugins.update).toHaveBeenCalledWith('summary', { enabled: false });

    panel.getComponent(VCombobox).vm.$emit('update:modelValue', ['api.anthropic.com', 'x.example']);
    await flushPromises();
    expect(api.admin.plugins.update).toHaveBeenLastCalledWith('summary', {
      approvedHosts: ['api.anthropic.com', 'x.example'],
    });

    await panel.find('input[type="password"]').setValue('sk-new');
    await panel.find('form').trigger('submit');
    await flushPromises();
    expect(api.admin.plugins.update).toHaveBeenLastCalledWith('summary', {
      settings: { apiKey: 'sk-new', model: 'big' },
    });
  });

  it('shows users their own settings of plugins with user scope', async () => {
    const panel = await mounted('user', { plugins: [webhook], uninstalled: [] });
    expect(panel.text()).not.toContain(t('plugins.serverSettings'));
    expect(panel.text()).toContain(t('plugins.urlHint', { hosts: 'hooks.example' }));
    const url = panel.find('input[type="url"]');
    expect(url.attributes('dir')).toBe('ltr');
    await url.setValue('https://hooks.example/b');
    await panel.find('form').trigger('submit');
    await flushPromises();
    expect(api.account.updatePlugin).toHaveBeenCalledWith('webhook', {
      settings: { target: 'https://hooks.example/b' },
    });
  });

  it("picks some of the user's feeds, keeping one they left until saved again", async () => {
    const choosy: Plugin = {
      ...webhook,
      id: 'choosy',
      messages: { en: { name: 'Choosy', 'settings.only': 'Feeds' } },
      settingsSchemas: {
        instance: null,
        user: {
          type: 'object',
          properties: {
            only: {
              type: 'array',
              items: { type: 'integer', exclusiveMinimum: 0 },
              default: [],
              newses: { feeds: true },
            },
          },
        },
      },
      user: { ...OFF, enabled: true, settings: { only: [9, 77] } },
    };
    api.account.updatePlugin.mockResolvedValue(choosy);
    const panel = await mounted('user', { plugins: [choosy], uninstalled: [] });
    const picker = panel.getComponent(VAutocomplete);
    expect(picker.props('items')).toEqual([
      { value: 4, title: 'Tech' },
      { value: 9, title: 'Weather' },
      { value: 77, title: t('plugins.feedGone', { id: 77 }) },
    ]);
    expect(panel.find('.v-chip bdi').text()).toBe('Weather');
    picker.vm.$emit('update:modelValue', [9, 4]);
    await panel.find('form').trigger('submit');
    await flushPromises();
    expect(api.account.updatePlugin).toHaveBeenCalledWith('choosy', { settings: { only: [9, 4] } });
  });

  it('tests a testable plugin with the saved settings, and says how it went', async () => {
    const testable = { ...webhook, testable: true };
    api.account.testPlugin.mockResolvedValueOnce({
      ok: false,
      message: 'HTTP 401 Unauthorized',
      failure: null,
    });
    const panel = await mounted('user', { plugins: [testable], uninstalled: [] });
    expect(panel.text()).toContain(t('plugins.testHint'));
    const send = panel.findAll('button').find((b) => b.text() === t('plugins.sendTest'));
    await send?.trigger('click');
    await flushPromises();
    expect(api.account.testPlugin).toHaveBeenCalledWith('webhook');
    expect(panel.text()).toContain(t('plugins.testFailed', { message: 'HTTP 401 Unauthorized' }));

    api.account.testPlugin.mockResolvedValueOnce({ ok: false, message: '', failure: 'timeout' });
    await send?.trigger('click');
    await flushPromises();
    expect(panel.text()).toContain(t('plugins.testFailure.timeout'));

    const untested = await mounted('user', { plugins: [webhook], uninstalled: [] });
    expect(untested.text()).not.toContain(t('plugins.sendTest'));
  });

  it('follows a passing test of a plugin that adds to digests with a test digest', async () => {
    const digesting = { ...webhook, testable: true, digests: true };
    api.account.testPlugin.mockResolvedValueOnce({
      ok: true,
      message: 'The key works',
      failure: null,
    });
    api.account.testDigest.mockResolvedValue(undefined);
    const panel = await mounted('user', { plugins: [digesting], uninstalled: [] });
    expect(panel.text()).toContain(t('plugins.testDigestHint'));
    const send = panel.findAll('button').find((b) => b.text() === t('plugins.sendTest'));
    await send?.trigger('click');
    await flushPromises();
    expect(api.account.testDigest).toHaveBeenCalledOnce();
    expect(panel.text()).toContain(t('plugins.testPassed', { message: 'The key works' }));
    expect(panel.text()).toContain(t('email.digest.testQueued'));

    // A failing test sends none.
    api.account.testPlugin.mockResolvedValueOnce({ ok: false, message: 'HTTP 401', failure: null });
    await send?.trigger('click');
    await flushPromises();
    expect(api.account.testDigest).toHaveBeenCalledOnce();
    expect(panel.text()).not.toContain(t('email.digest.testQueued'));

    // Without a test hook of its own, the test is the digest.
    const digestOnly = { ...webhook, testable: false, digests: true };
    const only = await mounted('user', { plugins: [digestOnly], uninstalled: [] });
    await only
      .findAll('button')
      .find((b) => b.text() === t('plugins.sendTest'))
      ?.trigger('click');
    await flushPromises();
    expect(api.account.testPlugin).toHaveBeenCalledTimes(2);
    expect(api.account.testDigest).toHaveBeenCalledTimes(2);
    expect(only.text()).toContain(t('email.digest.testQueued'));
    expect(only.text()).not.toContain(t('plugins.testPassedQuietly'));
  });

  it('says what the last run said when the server turned a plugin off', async () => {
    const stopped = {
      ...webhook,
      user: {
        ...OFF,
        failures: 10,
        lastFailure: 'error',
        lastFailureDetail: 'HTTP 404 Not Found',
        disabledReason: 'failures' as const,
      },
    };
    const panel = await mounted('user', { plugins: [stopped], uninstalled: [] });
    expect(panel.text()).toContain(
      t('plugins.turnedOffMineSaying', { count: 10, detail: 'HTTP 404 Not Found' }),
    );
  });
});
