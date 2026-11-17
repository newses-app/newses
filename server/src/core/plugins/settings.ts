import { MAX_PLUGIN_HOSTS } from '@newses/shared';
import { and, eq, gt, sql } from 'drizzle-orm';
import type { Db } from '../../db/client.ts';
import {
  pluginDeliveries,
  pluginEvents,
  pluginSettings,
  pluginStorage,
  pluginUserSettings,
} from '../../db/schema.ts';
import { CryptoError, open, seal } from '../crypto.ts';
import { DomainError } from '../errors.ts';
import type { PluginCatalog, PluginInfo, SettingsSpec } from './catalog.ts';

/** Failed runs in a row that turn a plugin off, for the instance or for one user. */
export const PLUGIN_FAILURE_LIMIT = 10;
/** Hosts an admin may approve for one plugin. */
export const MAX_APPROVED_HOSTS = MAX_PLUGIN_HOSTS;
/** A scope's settings and sealed secrets, as JSON. */
export const MAX_SETTINGS_BYTES = 64 * 1024;

const LABEL = '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?';
const HOSTNAME = new RegExp(`^(?=.{1,253}$)${LABEL}(?:\\.${LABEL})*$`);

/** Whether `host` is a lower-case host name (or IPv4 address), as plugins and admins name them. */
export const isHostName = (host: string) => HOSTNAME.test(host);

/** Why the server turned a plugin off. */
export type DisabledReason = 'failures';

/** A scope's settings without its secrets: which secrets are set, not their values. */
export interface PluginSettingsView {
  pluginId: string;
  enabled: boolean;
  settings: Record<string, unknown>;
  /** The secret fields that have a value. */
  secretsSet: string[];
  /** Failed runs in a row. */
  failures: number;
  lastFailure: string | null;
  lastFailureAt: Date | null;
  disabledReason: DisabledReason | null;
}

export interface InstancePluginSettingsView extends PluginSettingsView {
  approvedHosts: string[];
}

/**
 * A change to a scope's settings. `settings` replaces the plain fields; a secret field given a
 * string is set, given null is cleared, and left out keeps its value. Enabling clears a
 * shutdown after failures.
 */
export interface SettingsChange {
  enabled?: boolean | undefined;
  settings?: Record<string, unknown> | undefined;
}

/** What a hook run gets of the settings. */
export type PluginRuntime =
  | {
      active: true;
      approvedHosts: ReadonlySet<string>;
      settings: Record<string, unknown>;
      /** Set for a user's run of a plugin with user settings. */
      userSettings: Record<string, unknown> | null;
    }
  | {
      active: false;
      /** Off for the instance or the user, or settings the plugin no longer takes. */
      reason: 'disabled' | 'invalid_settings';
    };

type SettingsRow = typeof pluginSettings.$inferSelect;
type UserSettingsRow = typeof pluginUserSettings.$inferSelect;
type Owner = { scope: 'instance' } | { scope: 'user'; userId: number };

const secretContext = (pluginId: string, owner: Owner, field: string) =>
  owner.scope === 'instance'
    ? `plugin:${pluginId}:instance:${field}`
    : `plugin:${pluginId}:user:${String(owner.userId)}:${field}`;

/**
 * What admins and users set for plugins, kept by plugin id: enabling, settings checked against
 * the plugin's schema with secrets sealed with the `plugin-secrets` key, the hosts admins approve,
 * and the failed runs that turn a plugin off.
 */
export class PluginSettingsService {
  readonly #db: Db;
  readonly #key: Buffer;
  readonly #catalog: PluginCatalog;

  constructor(deps: { db: Db; key: Buffer; catalog: PluginCatalog }) {
    this.#db = deps.db;
    this.#key = deps.key;
    this.#catalog = deps.catalog;
  }

  /** Every plugin's instance settings, including plugins no longer installed. */
  async list(): Promise<InstancePluginSettingsView[]> {
    const rows = await this.#db.select().from(pluginSettings).orderBy(pluginSettings.pluginId);
    return rows.map((row) => this.#instanceView(row));
  }

  async instance(pluginId: string): Promise<InstancePluginSettingsView | null> {
    const [row] = await this.#db
      .select()
      .from(pluginSettings)
      .where(eq(pluginSettings.pluginId, pluginId));
    return row ? this.#instanceView(row) : null;
  }

  /** A user's settings of every plugin they set. */
  async listForUser(userId: number): Promise<PluginSettingsView[]> {
    const rows = await this.#db
      .select()
      .from(pluginUserSettings)
      .where(eq(pluginUserSettings.userId, userId))
      .orderBy(pluginUserSettings.pluginId);
    return rows.map((row) => this.#view(row));
  }

  /** The ids of plugins with settings or storage kept, installed or not. */
  async storedIds(): Promise<string[]> {
    const result = await this.#db.execute<{ plugin_id: string }>(sql`
      SELECT plugin_id FROM ${pluginSettings}
      UNION SELECT plugin_id FROM ${pluginUserSettings}
      UNION SELECT plugin_id FROM ${pluginStorage}
      ORDER BY plugin_id`);
    return result.rows.map((row) => row.plugin_id);
  }

  async user(pluginId: string, userId: number): Promise<PluginSettingsView | null> {
    const [row] = await this.#db
      .select()
      .from(pluginUserSettings)
      .where(and(eq(pluginUserSettings.pluginId, pluginId), eq(pluginUserSettings.userId, userId)));
    return row ? this.#view(row) : null;
  }

  /** Changes an installed plugin's instance settings, and the hosts it may reach. */
  async updateInstance(
    pluginId: string,
    change: SettingsChange & { approvedHosts?: string[] | undefined },
  ): Promise<InstancePluginSettingsView> {
    const info = this.#installed(pluginId);
    const approvedHosts = change.approvedHosts && approvedHostsOf(change.approvedHosts);
    return this.#db.transaction(async (tx) => {
      const [current] = await tx
        .select()
        .from(pluginSettings)
        .where(eq(pluginSettings.pluginId, pluginId))
        .for('update');
      const hosts = approvedHosts ?? current?.approvedHosts ?? [];
      const enabled = change.enabled ?? current?.enabled ?? false;
      const saved = this.#settingsOf(info, info.settings.instance, { scope: 'instance' }, current, {
        change,
        enabled,
        hosts,
      });
      const values = {
        enabled,
        approvedHosts: hosts,
        // As the server keeps them at startup, so the triggers see the plugin's hooks at once.
        hooks: [...info.events.keys()],
        userScope: info.scopes.includes('user'),
        ...saved,
        ...(change.enabled && { failures: 0, disabledReason: null }),
        updatedAt: sql`now()`,
      };
      const [row] = await tx
        .insert(pluginSettings)
        .values({ pluginId, ...values })
        .onConflictDoUpdate({ target: pluginSettings.pluginId, set: values })
        .returning();
      if (!row) throw new Error('Plugin settings were not saved');
      return this.#instanceView(row);
    });
  }

  /** Changes a user's settings of an installed plugin with user scope. */
  async updateUser(
    pluginId: string,
    userId: number,
    change: SettingsChange,
  ): Promise<PluginSettingsView> {
    const info = this.#installed(pluginId);
    if (!info.scopes.includes('user'))
      throw new DomainError('invalid_input', `The plugin ${pluginId} has no user settings`, {
        reason: 'plugin_no_user_settings',
      });
    return this.#db.transaction(async (tx) => {
      const [instance] = await tx
        .select({ approvedHosts: pluginSettings.approvedHosts })
        .from(pluginSettings)
        .where(eq(pluginSettings.pluginId, pluginId));
      const [current] = await tx
        .select()
        .from(pluginUserSettings)
        .where(
          and(eq(pluginUserSettings.pluginId, pluginId), eq(pluginUserSettings.userId, userId)),
        )
        .for('update');
      const enabled = change.enabled ?? current?.enabled ?? false;
      const saved = this.#settingsOf(info, info.settings.user, { scope: 'user', userId }, current, {
        change,
        enabled,
        hosts: instance?.approvedHosts ?? [],
      });
      const values = {
        enabled,
        ...saved,
        ...(change.enabled && { failures: 0, disabledReason: null }),
        updatedAt: sql`now()`,
      };
      const [row] = await tx
        .insert(pluginUserSettings)
        .values({ pluginId, userId, ...values })
        .onConflictDoUpdate({
          target: [pluginUserSettings.pluginId, pluginUserSettings.userId],
          set: values,
        })
        .returning();
      if (!row) throw new Error('Plugin settings were not saved');
      return this.#view(row);
    });
  }

  /**
   * Removes a plugin's settings, every user's, and its storage, installed or not; whether there
   * were any.
   */
  async remove(pluginId: string): Promise<boolean> {
    return this.#db.transaction(async (tx) => {
      const counts = [
        await tx.delete(pluginSettings).where(eq(pluginSettings.pluginId, pluginId)),
        await tx.delete(pluginUserSettings).where(eq(pluginUserSettings.pluginId, pluginId)),
        await tx.delete(pluginStorage).where(eq(pluginStorage.pluginId, pluginId)),
        await tx.delete(pluginEvents).where(eq(pluginEvents.pluginId, pluginId)),
        await tx.delete(pluginDeliveries).where(eq(pluginDeliveries.pluginId, pluginId)),
      ];
      return counts.some((result) => (result.rowCount ?? 0) > 0);
    });
  }

  /** Removes a user's settings of a plugin and the plugin's storage for them. */
  async removeUser(pluginId: string, userId: number): Promise<boolean> {
    return this.#db.transaction(async (tx) => {
      const counts = [
        await tx
          .delete(pluginUserSettings)
          .where(
            and(eq(pluginUserSettings.pluginId, pluginId), eq(pluginUserSettings.userId, userId)),
          ),
        await tx
          .delete(pluginStorage)
          .where(and(eq(pluginStorage.pluginId, pluginId), eq(pluginStorage.userId, userId))),
        await tx
          .delete(pluginEvents)
          .where(and(eq(pluginEvents.pluginId, pluginId), eq(pluginEvents.userId, userId))),
        await tx
          .delete(pluginDeliveries)
          .where(and(eq(pluginDeliveries.pluginId, pluginId), eq(pluginDeliveries.userId, userId))),
      ];
      return counts.some((result) => (result.rowCount ?? 0) > 0);
    });
  }

  /**
   * Whether a hook of the plugin may run, for a user or for the instance (`userId` null), and
   * with what: on for the instance and, with user scope, for the user; settings opened and
   * checked against the plugin's current schema. Throws CryptoError when a secret was sealed
   * under another APP_SECRET.
   */
  async runtime(plugin: PluginInfo, userId: number | null): Promise<PluginRuntime> {
    const [instance] = await this.#db
      .select()
      .from(pluginSettings)
      .where(eq(pluginSettings.pluginId, plugin.id));
    if (!instance?.enabled) return { active: false, reason: 'disabled' };
    const settings = this.#opened(plugin.settings.instance, { scope: 'instance' }, instance);
    if (!settings) return { active: false, reason: 'invalid_settings' };
    let userSettings: Record<string, unknown> | null = null;
    if (userId !== null && plugin.scopes.includes('user')) {
      const [row] = await this.#db
        .select()
        .from(pluginUserSettings)
        .where(
          and(eq(pluginUserSettings.pluginId, plugin.id), eq(pluginUserSettings.userId, userId)),
        );
      if (!row?.enabled) return { active: false, reason: 'disabled' };
      if (plugin.settings.user) {
        userSettings = this.#opened(plugin.settings.user, { scope: 'user', userId }, row);
        if (!userSettings) return { active: false, reason: 'invalid_settings' };
      }
    }
    return {
      active: true,
      approvedHosts: new Set(instance.approvedHosts),
      settings,
      userSettings,
    };
  }

  /**
   * Counts a hook run toward the plugin's failures in a row: a user's run of a plugin with user
   * settings toward that user, any other toward the instance. At `PLUGIN_FAILURE_LIMIT` the
   * plugin is turned off there; returns where it was.
   */
  async recordRun(
    plugin: PluginInfo,
    userId: number | null,
    outcome: { ok: true } | { ok: false; failure: string },
  ): Promise<'instance' | 'user' | null> {
    const forUser = userId !== null && plugin.settings.user !== null;
    const table = forUser ? pluginUserSettings : pluginSettings;
    const owner = forUser
      ? and(eq(pluginUserSettings.pluginId, plugin.id), eq(pluginUserSettings.userId, userId))
      : eq(pluginSettings.pluginId, plugin.id);
    if (outcome.ok) {
      await this.#db
        .update(table)
        .set({ failures: 0 })
        .where(and(owner, gt(table.failures, 0)));
      return null;
    }
    const reachesLimit = sql`${table.failures} + 1 >= ${PLUGIN_FAILURE_LIMIT}`;
    const [row] = await this.#db
      .update(table)
      .set({
        failures: sql`${table.failures} + 1`,
        lastFailure: outcome.failure,
        lastFailureAt: sql`now()`,
        enabled: sql`NOT (${reachesLimit})`,
        disabledReason: sql`CASE WHEN ${reachesLimit} THEN 'failures' END`,
      })
      .where(and(owner, eq(table.enabled, true)))
      .returning({ enabled: table.enabled });
    if (!row || row.enabled) return null;
    return forUser ? 'user' : 'instance';
  }

  /**
   * Re-seals every plugin secret sealed under `previousKey` (another instance's) with this key,
   * all or none; returns how many. Secrets this key opens already are left, so a run cut short
   * can be repeated. Throws when one opens under neither.
   */
  async reseal(previousKey: Buffer): Promise<number> {
    if (previousKey.equals(this.#key)) return 0;
    return this.#db.transaction(async (tx) => {
      let count = 0;
      const resealed = (pluginId: string, owner: Owner, secrets: Record<string, string>) => {
        let changed = false;
        const next: Record<string, string> = {};
        for (const [field, sealed] of Object.entries(secrets)) {
          const context = secretContext(pluginId, owner, field);
          if (opens(this.#key, sealed, context)) {
            next[field] = sealed;
            continue;
          }
          let value: string;
          try {
            value = open(previousKey, sealed, context);
          } catch (err) {
            if (!(err instanceof CryptoError)) throw err;
            throw new DomainError(
              'invalid_input',
              `The plugin ${pluginId}'s secret ${field} does not open with the previous secret`,
            );
          }
          next[field] = seal(this.#key, value, context);
          changed = true;
          count++;
        }
        return changed ? next : null;
      };
      const instances = await tx
        .select({ pluginId: pluginSettings.pluginId, secrets: pluginSettings.secrets })
        .from(pluginSettings)
        .for('update');
      for (const row of instances) {
        const next = resealed(row.pluginId, { scope: 'instance' }, row.secrets);
        if (next)
          await tx
            .update(pluginSettings)
            .set({ secrets: next })
            .where(eq(pluginSettings.pluginId, row.pluginId));
      }
      const users = await tx
        .select({
          pluginId: pluginUserSettings.pluginId,
          userId: pluginUserSettings.userId,
          secrets: pluginUserSettings.secrets,
        })
        .from(pluginUserSettings)
        .for('update');
      for (const row of users) {
        const next = resealed(row.pluginId, { scope: 'user', userId: row.userId }, row.secrets);
        if (next)
          await tx
            .update(pluginUserSettings)
            .set({ secrets: next })
            .where(
              and(
                eq(pluginUserSettings.pluginId, row.pluginId),
                eq(pluginUserSettings.userId, row.userId),
              ),
            );
      }
      return count;
    });
  }

  #installed(pluginId: string): PluginInfo {
    const info = this.#catalog.get(pluginId);
    if (!info) throw new DomainError('not_found', `No plugin ${pluginId} is installed`);
    return info;
  }

  /**
   * The settings and sealed secrets to save: the change applied to the current ones, checked
   * against the scope's schema when settings change or the scope is on, URLs only on `hosts`.
   */
  #settingsOf(
    info: PluginInfo,
    spec: SettingsSpec | null,
    owner: Owner,
    current: SettingsRow | UserSettingsRow | undefined,
    { change, enabled, hosts }: { change: SettingsChange; enabled: boolean; hosts: string[] },
  ): { settings: Record<string, unknown>; secrets: Record<string, string> } {
    const currentSettings = (current?.settings ?? {}) as Record<string, unknown>;
    const currentSecrets = current?.secrets ?? {};
    if (!spec) {
      const [field] = Object.keys(change.settings ?? {});
      if (field !== undefined)
        throw new DomainError('invalid_input', `The plugin ${info.id} has no setting ${field}`, {
          reason: 'plugin_setting_unknown',
          params: { name: field },
        });
      return { settings: {}, secrets: {} };
    }
    if (!change.settings && !enabled) return { settings: currentSettings, secrets: currentSecrets };

    const merged: Record<string, unknown> = {};
    for (const [field, { secret }] of spec.fields) {
      if (secret) {
        const given = change.settings?.[field];
        if (given === null) continue;
        if (given !== undefined) merged[field] = given;
        else if (currentSecrets[field] !== undefined)
          merged[field] = open(
            this.#key,
            currentSecrets[field],
            secretContext(info.id, owner, field),
          );
      } else if (change.settings) {
        if (change.settings[field] !== undefined) merged[field] = change.settings[field];
      } else if (currentSettings[field] !== undefined) merged[field] = currentSettings[field];
    }
    for (const field of Object.keys(change.settings ?? {}))
      if (!spec.fields.has(field))
        throw new DomainError('invalid_input', `The plugin ${info.id} has no setting ${field}`, {
          reason: 'plugin_setting_unknown',
          params: { name: field },
        });

    const parsed = spec.parse(merged);
    if (!parsed.ok)
      throw new DomainError('invalid_input', `Settings of ${info.id}: ${parsed.issues}`, {
        reason: 'plugin_settings_invalid',
        params: { detail: parsed.issues },
      });
    const settings: Record<string, unknown> = {};
    const secrets: Record<string, string> = {};
    for (const [field, value] of Object.entries(parsed.value)) {
      const kind = spec.fields.get(field);
      if (!kind || value === undefined) continue;
      if (kind.url && typeof value === 'string') {
        const host = new URL(value).hostname.toLowerCase();
        if (!hosts.includes(host))
          throw new DomainError(
            'invalid_input',
            `${host} is not approved for the plugin ${info.id}`,
            { reason: 'plugin_host_not_approved', params: { host } },
          );
      }
      // Secrets are strings (the registry refuses other marked fields); a null one is unset.
      if (kind.secret) {
        if (typeof value === 'string')
          secrets[field] = seal(this.#key, value, secretContext(info.id, owner, field));
      } else settings[field] = value;
    }
    if (JSON.stringify({ settings, secrets }).length > MAX_SETTINGS_BYTES)
      throw new DomainError('invalid_input', `Settings of ${info.id} are too large`, {
        reason: 'plugin_settings_too_large',
      });
    return { settings, secrets };
  }

  /** The scope's settings with secrets opened, as its schema takes them; null when it no longer does. */
  #opened(
    spec: SettingsSpec | null,
    owner: Owner,
    row: SettingsRow | UserSettingsRow,
  ): Record<string, unknown> | null {
    if (!spec) return {};
    const values: Record<string, unknown> = { ...(row.settings as Record<string, unknown>) };
    for (const [field, sealed] of Object.entries(row.secrets))
      values[field] = open(this.#key, sealed, secretContext(row.pluginId, owner, field));
    const parsed = spec.parse(values);
    return parsed.ok ? parsed.value : null;
  }

  #view(row: SettingsRow | UserSettingsRow): PluginSettingsView {
    return {
      pluginId: row.pluginId,
      enabled: row.enabled,
      settings: row.settings as Record<string, unknown>,
      secretsSet: Object.keys(row.secrets).sort(),
      failures: row.failures,
      lastFailure: row.lastFailure,
      lastFailureAt: row.lastFailureAt,
      disabledReason: row.disabledReason as DisabledReason | null,
    };
  }

  #instanceView(row: SettingsRow): InstancePluginSettingsView {
    return { ...this.#view(row), approvedHosts: row.approvedHosts };
  }
}

/** The hosts as given, lower-cased and once each; refuses anything but host names. */
function approvedHostsOf(hosts: string[]): string[] {
  const unique = [...new Set(hosts.map((host) => host.trim().toLowerCase()))];
  const invalid = unique.find((host) => !isHostName(host));
  if (invalid !== undefined)
    throw new DomainError('invalid_input', `${invalid} is not a host name`, {
      reason: 'invalid_host',
      params: { host: invalid },
    });
  if (unique.length > MAX_APPROVED_HOSTS)
    throw new DomainError(
      'invalid_input',
      `At most ${String(MAX_APPROVED_HOSTS)} hosts may be approved for a plugin`,
      { reason: 'plugin_hosts_limit', params: { max: MAX_APPROVED_HOSTS } },
    );
  return unique.sort();
}

function opens(key: Buffer, sealed: string, context: string): boolean {
  try {
    open(key, sealed, context);
    return true;
  } catch (err) {
    if (!(err instanceof CryptoError)) throw err;
    return false;
  }
}
