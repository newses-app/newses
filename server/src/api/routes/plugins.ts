import {
  type Plugin,
  pluginSchema,
  type PluginSettingsState,
  pluginsResponseSchema,
  updateAccountPluginRequestSchema,
  updatePluginRequestSchema,
} from '@newses/shared';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { DomainError } from '../../core/errors.ts';
import type { PluginInfo, PluginServices } from '../../core/plugins/index.ts';
import type { PluginSettingsView } from '../../core/plugins/settings.ts';
import { requireAdmin, requireAuth, requireUser } from '../auth.ts';
import { logSecurity } from '../security-log.ts';

const idParams = z.object({ id: z.string().regex(/^[a-z][a-z0-9-]{0,39}$/) });

const OFF: PluginSettingsState = {
  enabled: false,
  settings: {},
  secretsSet: [],
  failures: 0,
  lastFailure: null,
  lastFailureAt: null,
  disabledReason: null,
};

const stateOf = (view: PluginSettingsView | null | undefined): PluginSettingsState =>
  view
    ? {
        enabled: view.enabled,
        settings: view.settings,
        secretsSet: view.secretsSet,
        failures: view.failures,
        lastFailure: view.lastFailure,
        lastFailureAt: view.lastFailureAt?.toISOString() ?? null,
        disabledReason: view.disabledReason,
      }
    : OFF;

/**
 * Settings → Plugins: admins enable installed plugins, set their instance settings, and approve
 * their hosts; users turn on plugins with user scope and set their own settings. No settings
 * response carries a secret's value.
 */
export const pluginRoutes: FastifyPluginAsyncZod<{ plugins: PluginServices }> = (
  app,
  { plugins },
) => {
  const { catalog, settings } = plugins;

  /** A plugin as `viewer` sees it, with their own settings. */
  async function present(info: PluginInfo, viewer: { id: number; admin: boolean }) {
    const [instance, user] = await Promise.all([
      settings.instance(info.id),
      info.scopes.includes('user') ? settings.user(info.id, viewer.id) : null,
    ]);
    return dto(info, instance, user, viewer.admin);
  }

  function dto(
    info: PluginInfo,
    instance: Awaited<ReturnType<typeof settings.instance>>,
    user: PluginSettingsView | null,
    admin: boolean,
  ): Plugin {
    return {
      id: info.id,
      version: info.version,
      scopes: [...info.scopes],
      enabled: instance?.enabled ?? false,
      hosts: [...info.hosts],
      approvedHosts: instance?.approvedHosts ?? [],
      messages: info.messages,
      settingsSchemas: {
        instance: admin ? (info.settings.instance?.jsonSchema ?? null) : null,
        user: info.settings.user?.jsonSchema ?? null,
      },
      admin: admin ? { ...stateOf(instance), source: info.source } : null,
      user: info.scopes.includes('user') ? stateOf(user) : null,
    };
  }

  const viewerOf = (auth: ReturnType<typeof requireAuth>) => ({
    id: auth.user.id,
    admin: auth.user.role === 'admin',
  });

  app.get(
    '/plugins',
    { preHandler: requireUser, schema: { response: { 200: pluginsResponseSchema } } },
    async (request) => {
      const viewer = viewerOf(requireAuth(request));
      const [instances, users] = await Promise.all([
        settings.list(),
        settings.listForUser(viewer.id),
      ]);
      const instanceOf = new Map(instances.map((view) => [view.pluginId, view]));
      const userOf = new Map(users.map((view) => [view.pluginId, view]));
      const shown = catalog
        .list()
        .filter((info) => viewer.admin || instanceOf.get(info.id)?.enabled === true);
      return {
        plugins: shown.map((info) =>
          dto(info, instanceOf.get(info.id) ?? null, userOf.get(info.id) ?? null, viewer.admin),
        ),
        uninstalled: viewer.admin
          ? (await settings.storedIds()).filter((id) => !catalog.get(id))
          : [],
      };
    },
  );

  app.patch(
    '/admin/plugins/:id',
    {
      preHandler: requireAdmin,
      schema: {
        params: idParams,
        body: updatePluginRequestSchema,
        response: { 200: pluginSchema },
      },
    },
    async (request) => {
      const { id } = request.params;
      const change = request.body;
      const view = await settings.updateInstance(id, change);
      logSecurity(request, 'plugin_updated', {
        pluginId: id,
        enabled: view.enabled,
        approvedHosts: view.approvedHosts,
        ...(change.settings && { settings: Object.keys(change.settings).sort() }),
      });
      const info = catalog.get(id);
      if (!info) throw new DomainError('not_found', `No plugin ${id} is installed`);
      return present(info, viewerOf(requireAuth(request)));
    },
  );

  app.delete(
    '/admin/plugins/:id',
    { preHandler: requireAdmin, schema: { params: idParams } },
    async (request, reply) => {
      const { id } = request.params;
      if (!(await settings.remove(id)))
        throw new DomainError('not_found', `No settings of the plugin ${id}`);
      logSecurity(request, 'plugin_removed', { pluginId: id });
      return reply.code(204).send();
    },
  );

  app.patch(
    '/account/plugins/:id',
    {
      preHandler: requireUser,
      schema: {
        params: idParams,
        body: updateAccountPluginRequestSchema,
        response: { 200: pluginSchema },
      },
    },
    async (request) => {
      const { id } = request.params;
      const viewer = viewerOf(requireAuth(request));
      const info = catalog.get(id);
      // Users see only plugins an admin turned on.
      if (!info || (!viewer.admin && (await settings.instance(id))?.enabled !== true))
        throw new DomainError('not_found', `No plugin ${id} is on`);
      await settings.updateUser(id, viewer.id, request.body);
      return present(info, viewer);
    },
  );

  app.delete(
    '/account/plugins/:id',
    { preHandler: requireUser, schema: { params: idParams } },
    async (request, reply) => {
      await settings.removeUser(request.params.id, requireAuth(request).user.id);
      return reply.code(204).send();
    },
  );

  return Promise.resolve();
};
