import { desc, eq, isNull, or, sql } from 'drizzle-orm';
import type { Db } from '../../db/client.ts';
import { opsAlerts, opsState } from '../../db/schema.ts';
import type { OpsSettings } from '../config.ts';

export interface OpsSummary {
  /** When the ops check last ran, or null if it never has. */
  checkedAt: Date | null;
  openAlerts: number;
  /** Users with an API request in the last 24 hours. */
  activeUsers: number;
  requests: number;
  serverErrors: number;
  slowRequests: number;
  outbound: { requests: number; notModified: number; failures: number; rateLimited: number };
  hosts: number;
  jobs: { runs: number; failures: number };
}

export interface HostStats {
  host: string;
  requests: number;
  ok: number;
  notModified: number;
  clientErrors: number;
  serverErrors: number;
  rateLimited: number;
  timeouts: number;
  networkErrors: number;
  other: number;
  bytes: number;
  avgMs: number;
  /** Most requests in any one hour of the window. */
  peakHourRequests: number;
  blockedUntil: Date | null;
  /** Admins' minimum interval between feed checks of the host. */
  minIntervalSeconds: number | null;
}

export interface HourlyOutbound {
  hour: Date;
  requests: number;
  failures: number;
  rateLimited: number;
}

export interface JobStats {
  job: string;
  runs: number;
  failures: number;
  avgMs: number;
  maxMs: number;
}

export interface HourlyJobs {
  hour: Date;
  runs: number;
  failures: number;
}

export interface UserActivity {
  id: number;
  login: string;
  role: string;
  disabled: boolean;
  lastSeenAt: Date | null;
  requests7d: number;
  requests30d: number;
  /** Requests in 30 days by client. */
  clients: Record<string, number>;
  read7d: number;
  read30d: number;
}

export interface OpsAlertRecord {
  id: number;
  rule: string;
  subject: string;
  severity: string;
  openedAt: Date;
  lastSeenAt: Date;
  resolvedAt: Date | null;
  details: Record<string, unknown>;
}

const FAILURE_OUTCOMES = sql`('client_error', 'server_error', 'timeout', 'network', 'other')`;
const since = (hours: number) => sql`now() - make_interval(hours => ${hours})`;

/** Read side of the ops tables for the admin Operations page, plus retention. */
export class OpsReports {
  readonly #db: Db;
  readonly #settings: OpsSettings;

  constructor(db: Db, settings: OpsSettings) {
    this.#db = db;
    this.#settings = settings;
  }

  get hostHourlyBudget(): number {
    return this.#settings.hostHourlyBudget;
  }

  async summary(): Promise<OpsSummary> {
    const [check] = await this.#db.select().from(opsState).where(eq(opsState.key, 'check'));
    const result = await this.#db.execute<{
      open_alerts: number;
      active_users: number;
      requests: number;
      server_errors: number;
      slow_requests: number;
      outbound: number;
      not_modified: number;
      failures: number;
      rate_limited: number;
      hosts: number;
      runs: number;
      job_failures: number;
    }>(sql`
      SELECT
        (SELECT count(*)::int FROM ops_alerts WHERE resolved_at IS NULL) AS open_alerts,
        (SELECT count(DISTINCT user_id)::int FROM user_activity_daily
          WHERE last_seen_at >= ${since(24)}) AS active_users,
        r.requests, r.server_errors, r.slow_requests,
        o.outbound, o.not_modified, o.failures, o.rate_limited, o.hosts,
        j.runs, j.job_failures
      FROM
        (SELECT coalesce(sum(requests), 0)::int AS requests,
           coalesce(sum(requests) FILTER (WHERE status_class = '5xx'), 0)::int AS server_errors,
           coalesce(sum(slow), 0)::int AS slow_requests
         FROM request_stats_hourly WHERE hour >= ${since(24)}) r,
        (SELECT coalesce(sum(requests), 0)::int AS outbound,
           coalesce(sum(requests) FILTER (WHERE outcome = 'not_modified'), 0)::int AS not_modified,
           coalesce(sum(requests) FILTER (WHERE outcome IN ${FAILURE_OUTCOMES}), 0)::int AS failures,
           coalesce(sum(requests) FILTER (WHERE outcome = 'rate_limited'), 0)::int AS rate_limited,
           count(DISTINCT host)::int AS hosts
         FROM host_fetch_stats_hourly WHERE hour >= ${since(24)}) o,
        (SELECT coalesce(sum(runs), 0)::int AS runs,
           coalesce(sum(failures), 0)::int AS job_failures
         FROM job_stats_hourly WHERE hour >= ${since(24)}) j`);
    const row = result.rows[0];
    if (!row) throw new Error('Summary query returned no row');
    return {
      checkedAt: check?.updatedAt ?? null,
      openAlerts: row.open_alerts,
      activeUsers: row.active_users,
      requests: row.requests,
      serverErrors: row.server_errors,
      slowRequests: row.slow_requests,
      outbound: {
        requests: row.outbound,
        notModified: row.not_modified,
        failures: row.failures,
        rateLimited: row.rate_limited,
      },
      hosts: row.hosts,
      jobs: { runs: row.runs, failures: row.job_failures },
    };
  }

  /** Hosts asked in the last `hours`, busiest first. */
  async hosts(
    hours: number,
    limit = 200,
  ): Promise<{ hosts: HostStats[]; hourly: HourlyOutbound[] }> {
    const hosts = await this.#db.execute<{
      host: string;
      requests: number;
      ok: number;
      not_modified: number;
      client_errors: number;
      server_errors: number;
      rate_limited: number;
      timeouts: number;
      network_errors: number;
      other: number;
      bytes: number;
      total_ms: number;
      peak: number;
      blocked_until: string | null;
      min_interval_seconds: number | null;
    }>(sql`
      WITH hourly AS (
        SELECT host, hour, sum(requests) AS requests FROM host_fetch_stats_hourly
        WHERE hour >= ${since(hours)} GROUP BY host, hour
      )
      SELECT s.host,
        sum(s.requests)::int AS requests,
        coalesce(sum(s.requests) FILTER (WHERE s.outcome = 'ok'), 0)::int AS ok,
        coalesce(sum(s.requests) FILTER (WHERE s.outcome = 'not_modified'), 0)::int AS not_modified,
        coalesce(sum(s.requests) FILTER (WHERE s.outcome = 'client_error'), 0)::int AS client_errors,
        coalesce(sum(s.requests) FILTER (WHERE s.outcome = 'server_error'), 0)::int AS server_errors,
        coalesce(sum(s.requests) FILTER (WHERE s.outcome = 'rate_limited'), 0)::int AS rate_limited,
        coalesce(sum(s.requests) FILTER (WHERE s.outcome = 'timeout'), 0)::int AS timeouts,
        coalesce(sum(s.requests) FILTER (WHERE s.outcome = 'network'), 0)::int AS network_errors,
        coalesce(sum(s.requests) FILTER (WHERE s.outcome IN ('blocked', 'other')), 0)::int AS other,
        sum(s.bytes)::float8 AS bytes,
        sum(s.total_ms)::float8 AS total_ms,
        (SELECT max(requests)::int FROM hourly h WHERE h.host = s.host) AS peak,
        (SELECT blocked_until::text FROM fetch_hosts f
          WHERE f.host = s.host AND f.blocked_until > now()) AS blocked_until,
        (SELECT r.min_interval_seconds FROM fetch_host_rules r WHERE r.host = s.host)
          AS min_interval_seconds
      FROM host_fetch_stats_hourly s
      WHERE s.hour >= ${since(hours)}
      GROUP BY s.host
      ORDER BY sum(s.requests) DESC, s.host
      LIMIT ${limit}`);
    const hourly = await this.#db.execute<{
      hour: string;
      requests: number;
      failures: number;
      rate_limited: number;
    }>(sql`
      SELECT hour::text, sum(requests)::int AS requests,
        coalesce(sum(requests) FILTER (WHERE outcome IN ${FAILURE_OUTCOMES}), 0)::int AS failures,
        coalesce(sum(requests) FILTER (WHERE outcome = 'rate_limited'), 0)::int AS rate_limited
      FROM host_fetch_stats_hourly WHERE hour >= ${since(hours)}
      GROUP BY hour ORDER BY hour`);
    return {
      hosts: hosts.rows.map((row) => ({
        host: row.host,
        requests: row.requests,
        ok: row.ok,
        notModified: row.not_modified,
        clientErrors: row.client_errors,
        serverErrors: row.server_errors,
        rateLimited: row.rate_limited,
        timeouts: row.timeouts,
        networkErrors: row.network_errors,
        other: row.other,
        bytes: row.bytes,
        avgMs: Math.round(row.total_ms / row.requests),
        peakHourRequests: row.peak,
        blockedUntil: row.blocked_until ? new Date(row.blocked_until) : null,
        minIntervalSeconds: row.min_interval_seconds,
      })),
      hourly: hourly.rows.map((row) => ({
        hour: new Date(row.hour),
        requests: row.requests,
        failures: row.failures,
        rateLimited: row.rate_limited,
      })),
    };
  }

  async jobs(hours: number): Promise<{ jobs: JobStats[]; hourly: HourlyJobs[] }> {
    const jobs = await this.#db.execute<{
      job: string;
      runs: number;
      failures: number;
      total_ms: number;
      max_ms: number;
    }>(sql`
      SELECT job, sum(runs)::int AS runs, sum(failures)::int AS failures,
        sum(total_ms)::float8 AS total_ms, max(max_ms)::int AS max_ms
      FROM job_stats_hourly WHERE hour >= ${since(hours)}
      GROUP BY job ORDER BY job`);
    const hourly = await this.#db.execute<{ hour: string; runs: number; failures: number }>(sql`
      SELECT hour::text, sum(runs)::int AS runs, sum(failures)::int AS failures
      FROM job_stats_hourly WHERE hour >= ${since(hours)}
      GROUP BY hour ORDER BY hour`);
    return {
      jobs: jobs.rows.map((row) => ({
        job: row.job,
        runs: row.runs,
        failures: row.failures,
        avgMs: Math.round(row.total_ms / row.runs),
        maxMs: row.max_ms,
      })),
      hourly: hourly.rows.map((row) => ({
        hour: new Date(row.hour),
        runs: row.runs,
        failures: row.failures,
      })),
    };
  }

  /** Every user with their activity over 7 and 30 days. */
  async users(): Promise<UserActivity[]> {
    const result = await this.#db.execute<{
      id: number;
      login: string;
      role: string;
      disabled: boolean;
      last_seen_at: string | null;
      requests_7d: number;
      requests_30d: number;
      clients: Record<string, number> | null;
      read_7d: number;
      read_30d: number;
    }>(sql`
      SELECT u.id, u.login, u.role, u.disabled_at IS NOT NULL AS disabled,
        greatest(a.last_seen_at, u.last_login_at)::text AS last_seen_at,
        coalesce(a.requests_7d, 0)::int AS requests_7d,
        coalesce(a.requests_30d, 0)::int AS requests_30d,
        a.clients,
        coalesce(r.read_7d, 0)::int AS read_7d,
        coalesce(r.read_30d, 0)::int AS read_30d
      FROM users u
      LEFT JOIN LATERAL (
        SELECT max(last_seen_at) AS last_seen_at,
          sum(requests) FILTER (WHERE day >= current_date - 6) AS requests_7d,
          sum(requests) AS requests_30d,
          (SELECT jsonb_object_agg(client, n) FROM (
            SELECT client, sum(requests)::int AS n FROM user_activity_daily c
            WHERE c.user_id = u.id AND c.day >= current_date - 29 GROUP BY client) per_client
          ) AS clients
        FROM user_activity_daily d
        WHERE d.user_id = u.id AND d.day >= current_date - 29
      ) a ON true
      LEFT JOIN LATERAL (
        SELECT count(*) FILTER (WHERE read_at >= now() - interval '7 days') AS read_7d,
          count(*) AS read_30d
        FROM user_entries ue
        WHERE ue.user_id = u.id AND ue.read_at >= now() - interval '30 days'
      ) r ON true
      ORDER BY u.login`);
    return result.rows.map((row) => ({
      id: row.id,
      login: row.login,
      role: row.role,
      disabled: row.disabled,
      lastSeenAt: row.last_seen_at ? new Date(row.last_seen_at) : null,
      requests7d: row.requests_7d,
      requests30d: row.requests_30d,
      clients: row.clients ?? {},
      read7d: row.read_7d,
      read30d: row.read_30d,
    }));
  }

  /** Open alerts and those resolved in the last `days`, newest first. */
  async alerts(days = 7): Promise<OpsAlertRecord[]> {
    const rows = await this.#db
      .select()
      .from(opsAlerts)
      .where(
        or(
          isNull(opsAlerts.resolvedAt),
          sql`${opsAlerts.resolvedAt} >= now() - make_interval(days => ${days})`,
        ),
      )
      .orderBy(sql`${opsAlerts.resolvedAt} IS NOT NULL`, desc(opsAlerts.lastSeenAt))
      .limit(200);
    return rows.map((row) => ({ ...row, details: row.details as Record<string, unknown> }));
  }

  /** Deletes rollups and resolved alerts older than the retention period. */
  async prune(): Promise<number> {
    const days = this.#settings.retentionDays;
    const cutoff = sql`now() - make_interval(days => ${days})`;
    let deleted = 0;
    for (const statement of [
      sql`DELETE FROM request_stats_hourly WHERE hour < ${cutoff}`,
      sql`DELETE FROM host_fetch_stats_hourly WHERE hour < ${cutoff}`,
      sql`DELETE FROM job_stats_hourly WHERE hour < ${cutoff}`,
      sql`DELETE FROM user_activity_daily WHERE day < (${cutoff})::date`,
      sql`DELETE FROM ops_alerts WHERE resolved_at < ${cutoff}`,
    ]) {
      deleted += (await this.#db.execute(statement)).rowCount ?? 0;
    }
    return deleted;
  }
}
