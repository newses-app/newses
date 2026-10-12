import type { Db } from '../../db/client.ts';
import type { OpsSettings } from '../config.ts';
import type { Logger, Notifier } from '../ports.ts';
import { AuditLog } from './audit.ts';
import { NoopNotifier, OpsChecker, type QueueBacklog } from './check.ts';
import { OpsRecorder } from './recorder.ts';
import { OpsReports } from './reports.ts';

export interface OpsDeps {
  db: Db;
  logger: Logger;
  settings: OpsSettings;
  /** Alert emails; alerts stay in the app without one. */
  notifier?: Notifier | undefined;
  backlog?: (() => Promise<QueueBacklog[]>) | undefined;
}

export function createOpsServices(deps: OpsDeps) {
  const { db, logger, settings } = deps;
  const audit = new AuditLog(db, logger);
  const reports = new OpsReports(db, settings);
  return {
    recorder: new OpsRecorder(db, logger),
    audit,
    checker: new OpsChecker({
      db,
      logger,
      settings,
      notifier: deps.notifier ?? new NoopNotifier(),
      ...(deps.backlog && { backlog: deps.backlog }),
    }),
    reports,
    /** Applies the retention periods; run with the other purges. */
    async prune(): Promise<{ stats: number; audit: number }> {
      return {
        stats: await reports.prune(),
        audit: await audit.prune(settings.auditRetentionDays),
      };
    },
  };
}

export type OpsServices = ReturnType<typeof createOpsServices>;
