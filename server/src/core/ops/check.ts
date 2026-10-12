import { and, eq, isNull, sql } from 'drizzle-orm';
import type { Db } from '../../db/client.ts';
import { opsAlerts, opsState } from '../../db/schema.ts';
import type { OpsSettings } from '../config.ts';
import type { AlertNotice, Logger, Notifier } from '../ports.ts';

export type AlertSeverity = AlertNotice['severity'];

/** A condition the check found; it keeps an alert open while it holds. */
export interface Finding {
  rule: string;
  subject: string;
  severity: AlertSeverity;
  summary: string;
  details: Record<string, unknown>;
}

/** Jobs waiting in a queue that a worker could run now. */
export interface QueueBacklog {
  queue: string;
  ready: number;
}

/** Thresholds for the rules; the host budget comes from settings. */
export const RULES = {
  /** A host failing at least this share of requests, over at least `minRequests` in 6 hours. */
  hostFailing: { ratio: 0.5, minRequests: 10 },
  /** A job failing more than this share of runs, over at least `minRuns` in the last hour. */
  jobsFailing: { ratio: 0.2, minRuns: 5 },
  /** Jobs ready in one queue at check time. */
  backlogReady: 100,
  /** Feeds overdue by this many hours mean fetching has stalled. */
  staleHours: 2,
  /** Share of API requests failing with 5xx, over at least `minRequests` in the last hour. */
  apiErrors: { ratio: 0.05, minRequests: 20 },
} as const;

/** Rollup buckets of the current and previous hour, so a check sees at least a full hour. */
const LAST_HOUR = sql`date_trunc('hour', now()) - interval '1 hour'`;
const LAST_6_HOURS = sql`date_trunc('hour', now()) - interval '6 hours'`;

const CHECK_STATE_KEY = 'check';

const percent = (ratio: number) => `${String(Math.round(ratio * 100))}%`;

/**
 * Evaluates the alert rules over the ops rollups, opens and resolves `ops_alerts`, and notifies on
 * every change. Run from one process at a time (the worker, or the dispatch tick on AWS).
 */
export class OpsChecker {
  readonly #db: Db;
  readonly #logger: Logger;
  readonly #notifier: Notifier;
  readonly #settings: OpsSettings;
  readonly #backlog: (() => Promise<QueueBacklog[]>) | null;

  constructor(args: {
    db: Db;
    logger: Logger;
    notifier: Notifier;
    settings: OpsSettings;
    /** Queue depths, where the queue can report them. */
    backlog?: () => Promise<QueueBacklog[]>;
  }) {
    this.#db = args.db;
    this.#logger = args.logger;
    this.#notifier = args.notifier;
    this.#settings = args.settings;
    this.#backlog = args.backlog ?? null;
  }

  async run(): Promise<{ open: number; opened: number; resolved: number }> {
    const findings = await this.evaluate();
    const open = await this.#db.select().from(opsAlerts).where(isNull(opsAlerts.resolvedAt));
    const key = (rule: string, subject: string) => `${rule}\u0000${subject}`;
    const found = new Map(findings.map((f) => [key(f.rule, f.subject), f]));
    const notices: AlertNotice[] = [];

    for (const finding of findings) {
      const existing = open.find((a) => a.rule === finding.rule && a.subject === finding.subject);
      if (existing) {
        await this.#db
          .update(opsAlerts)
          .set({
            lastSeenAt: sql`now()`,
            severity: finding.severity,
            details: { summary: finding.summary, ...finding.details },
          })
          .where(eq(opsAlerts.id, existing.id));
        continue;
      }
      await this.#db
        .insert(opsAlerts)
        .values({
          rule: finding.rule,
          subject: finding.subject,
          severity: finding.severity,
          details: { summary: finding.summary, ...finding.details },
        })
        .onConflictDoNothing();
      notices.push({ change: 'opened', ...finding });
      this.#logger.warn({ rule: finding.rule, subject: finding.subject }, 'Ops alert opened');
    }

    for (const alert of open) {
      if (found.has(key(alert.rule, alert.subject))) continue;
      await this.#db
        .update(opsAlerts)
        .set({ resolvedAt: sql`now()` })
        .where(and(eq(opsAlerts.id, alert.id), isNull(opsAlerts.resolvedAt)));
      const details = alert.details as { summary?: unknown };
      notices.push({
        change: 'resolved',
        rule: alert.rule,
        subject: alert.subject,
        severity: alert.severity as AlertSeverity,
        summary: typeof details.summary === 'string' ? details.summary : alert.rule,
      });
      this.#logger.info({ rule: alert.rule, subject: alert.subject }, 'Ops alert resolved');
    }

    await this.#db
      .insert(opsState)
      .values({ key: CHECK_STATE_KEY, value: { open: findings.length } })
      .onConflictDoUpdate({
        target: opsState.key,
        set: { value: { open: findings.length }, updatedAt: sql`now()` },
      });

    if (notices.length > 0) {
      await this.#notifier.notify(notices).catch((err: unknown) => {
        this.#logger.error({ err }, 'Alert notification failed');
      });
    }
    return {
      open: findings.length,
      opened: notices.filter((n) => n.change === 'opened').length,
      resolved: notices.filter((n) => n.change === 'resolved').length,
    };
  }

  /** The conditions that hold now. */
  async evaluate(): Promise<Finding[]> {
    return [
      ...(await this.#hostFindings()),
      ...(await this.#jobFindings()),
      ...(await this.#backlogFindings()),
      ...(await this.#staleFindings()),
      ...(await this.#apiFindings()),
    ];
  }

  async #hostFindings(): Promise<Finding[]> {
    const findings: Finding[] = [];
    const recent = await this.#db.execute<{
      host: string;
      rate_limited: number;
      peak: number;
    }>(sql`
      SELECT host, sum(rate_limited)::int AS rate_limited, max(requests)::int AS peak
      FROM (
        SELECT host, hour, sum(requests) AS requests,
          sum(requests) FILTER (WHERE outcome = 'rate_limited') AS rate_limited
        FROM host_fetch_stats_hourly WHERE hour >= ${LAST_HOUR}
        GROUP BY host, hour
      ) hourly
      GROUP BY host`);
    const budget = this.#settings.hostHourlyBudget;
    for (const row of recent.rows) {
      if (row.rate_limited > 0) {
        findings.push({
          rule: 'host.rate_limited',
          subject: row.host,
          severity: 'warning',
          summary: `${row.host} asked us to slow down (429 or 503 with Retry-After)`,
          details: { rateLimited: row.rate_limited },
        });
      }
      if (row.peak > budget) {
        findings.push({
          rule: 'host.over_budget',
          subject: row.host,
          severity: 'warning',
          summary: `${String(row.peak)} requests to ${row.host} in one hour (budget ${String(budget)})`,
          details: { peakHourRequests: row.peak, budget },
        });
      }
    }

    const { ratio, minRequests } = RULES.hostFailing;
    const failing = await this.#db.execute<{ host: string; requests: number; failures: number }>(
      sql`
      SELECT host, sum(requests)::int AS requests,
        (sum(requests) FILTER (
          WHERE outcome IN ('client_error', 'server_error', 'timeout', 'network', 'other')
        ))::int AS failures
      FROM host_fetch_stats_hourly WHERE hour >= ${LAST_6_HOURS}
      GROUP BY host
      HAVING sum(requests) >= ${minRequests}`,
    );
    for (const row of failing.rows) {
      const share = (row.failures || 0) / row.requests;
      if (share < ratio) continue;
      findings.push({
        rule: 'host.failing',
        subject: row.host,
        severity: 'warning',
        summary: `${percent(share)} of ${String(row.requests)} requests to ${row.host} failed in 6 hours`,
        details: { requests: row.requests, failures: row.failures },
      });
    }
    return findings;
  }

  async #jobFindings(): Promise<Finding[]> {
    const { ratio, minRuns } = RULES.jobsFailing;
    const result = await this.#db.execute<{ job: string; runs: number; failures: number }>(sql`
      SELECT job, sum(runs)::int AS runs, sum(failures)::int AS failures
      FROM job_stats_hourly WHERE hour >= ${LAST_HOUR}
      GROUP BY job HAVING sum(runs) >= ${minRuns}`);
    return result.rows
      .filter((row) => row.failures / row.runs > ratio)
      .map((row) => ({
        rule: 'jobs.failing',
        subject: row.job,
        severity: 'critical' as const,
        summary: `${String(row.failures)} of ${String(row.runs)} ${row.job} runs failed in the last hour`,
        details: { runs: row.runs, failures: row.failures },
      }));
  }

  async #backlogFindings(): Promise<Finding[]> {
    if (!this.#backlog) return [];
    const queues = await this.#backlog();
    return queues
      .filter((queue) => queue.ready >= RULES.backlogReady)
      .map((queue) => ({
        rule: 'jobs.backlog',
        subject: queue.queue,
        severity: 'warning' as const,
        summary: `${String(queue.ready)} ${queue.queue} jobs are waiting for a worker`,
        details: { ready: queue.ready },
      }));
  }

  async #staleFindings(): Promise<Finding[]> {
    const result = await this.#db.execute<{ overdue: number; oldest: string | null }>(sql`
      SELECT count(*)::int AS overdue, min(next_fetch_at)::text AS oldest
      FROM feed_sources fs
      WHERE fs.disabled_at IS NULL
        AND fs.next_fetch_at < now() - make_interval(hours => ${RULES.staleHours})
        AND EXISTS (SELECT 1 FROM subscriptions s WHERE s.feed_source_id = fs.id)`);
    const row = result.rows[0];
    if (!row || row.overdue === 0) return [];
    return [
      {
        rule: 'ingest.stale',
        subject: 'all',
        severity: 'critical',
        summary: `${String(row.overdue)} feeds are more than ${String(RULES.staleHours)} hours overdue; fetching may have stalled`,
        details: { overdue: row.overdue, oldestDue: row.oldest },
      },
    ];
  }

  async #apiFindings(): Promise<Finding[]> {
    const { ratio, minRequests } = RULES.apiErrors;
    const result = await this.#db.execute<{ requests: number; errors: number }>(sql`
      SELECT coalesce(sum(requests), 0)::int AS requests,
        coalesce(sum(requests) FILTER (WHERE status_class = '5xx'), 0)::int AS errors
      FROM request_stats_hourly WHERE hour >= ${LAST_HOUR}`);
    const row = result.rows[0];
    if (!row || row.requests < minRequests) return [];
    const share = row.errors / row.requests;
    if (share <= ratio) return [];
    return [
      {
        rule: 'api.errors',
        subject: 'all',
        severity: 'critical',
        summary: `${percent(share)} of ${String(row.requests)} API requests failed with a server error in the last hour`,
        details: { requests: row.requests, errors: row.errors },
      },
    ];
  }
}

/** Subject line and plain-text body for an email (or similar) about alert changes. */
export function describeNotices(
  notices: AlertNotice[],
  publicUrl: string | null,
): { subject: string; text: string } {
  const opened = notices.filter((n) => n.change === 'opened');
  const resolved = notices.filter((n) => n.change === 'resolved');
  const parts = [
    opened.length > 0 ? `${String(opened.length)} opened` : null,
    resolved.length > 0 ? `${String(resolved.length)} resolved` : null,
  ].filter(Boolean);
  const critical = opened.some((n) => n.severity === 'critical');
  const subject = `[Newses] ${critical ? 'CRITICAL: ' : ''}alerts ${parts.join(', ')}`;
  const line = (n: AlertNotice) => `- [${n.severity}] ${n.rule} (${n.subject}): ${n.summary}`;
  const sections = [
    opened.length > 0 ? `Opened:\n${opened.map(line).join('\n')}` : null,
    resolved.length > 0 ? `Resolved:\n${resolved.map(line).join('\n')}` : null,
    publicUrl ? `Operations: ${publicUrl}/settings/operations` : null,
  ].filter(Boolean);
  return { subject, text: `${sections.join('\n\n')}\n` };
}

/** Sends nothing; alerts stay visible on the Operations page. */
export class NoopNotifier implements Notifier {
  notify(): Promise<void> {
    return Promise.resolve();
  }
}
