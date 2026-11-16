import type { Plugin, PluginsResponse, PluginSettingsState } from '@newses/shared';
import { QueryClient } from '@tanstack/vue-query';
import { enableAutoUnmount, flushPromises } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { VCombobox, VSwitch } from 'vuetify/components';
import { SESSION_KEY } from '../../composables/useSession.ts';
import { i18n } from '../../plugins/i18n.ts';
import { mountInApp } from '../../test/mount.ts';
import PluginsPanel from './PluginsPanel.vue';

const api = vi.hoisted(() => ({
  plugins: { list: vi.fn<() => Promise<PluginsResponse>>() },
  admin: { plugins: { update: vi.fn(), remove: vi.fn() } },
  account: { updatePlugin: vi.fn(), removePlugin: vi.fn() },
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
});
