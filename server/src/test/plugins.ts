import { multiline, secret, url } from '@newses/plugin-api';
import { z } from 'zod';
import { PluginRegistry } from '../plugins/registry.ts';
import { silentLogger } from './fakes.ts';

/** A webhook users point at their own URL, and a summary admins set up for everyone. */
export const FIXTURE_PLUGINS = [
  {
    source: '@newses/plugin-webhook@1.0.0',
    plugin: {
      id: 'webhook',
      version: '1.0.0',
      apiVersion: '^0.1',
      scopes: ['user'],
      settings: {
        user: z.object({
          target: url({ secret: true }),
          method: z.enum(['POST', 'PUT']).default('POST'),
          body: multiline().optional(),
          headers: z.array(z.object({ name: z.string(), value: z.string() })).default([]),
        }),
      },
      messages: {
        en: { name: 'Webhook', 'settings.target': 'URL' },
        de: { name: 'Webhook (de)' },
      },
      hooks: { test: { run: () => ({ ok: true, message: 'HTTP 204 No Content' }) } },
    },
  },
  {
    source: '@newses/plugin-summary@2.0.0',
    plugin: {
      id: 'summary',
      version: '2.0.0',
      apiVersion: '^0.1',
      scopes: ['instance', 'user'],
      hosts: ['api.anthropic.com'],
      settings: {
        instance: z.object({ apiKey: secret(), model: z.string().default('m') }),
      },
      hooks: { 'digest.compose': { run: () => ({ overview: 'Votes, mostly.' }) } },
    },
  },
] as const;

/** A catalog of the fixture plugins, as the registry loads them. */
export const testPluginCatalog = () =>
  PluginRegistry.load(FIXTURE_PLUGINS, { logger: silentLogger });
