import { z } from 'zod';

/** Time window of the Operations page's host and job statistics. */
export const opsWindowSchema = z.enum(['24h', '7d']);
export type OpsWindow = z.infer<typeof opsWindowSchema>;

export const opsSummarySchema = z.object({
  /** When the ops check last ran; null if it never has. */
  checkedAt: z.iso.datetime().nullable(),
  openAlerts: z.number().int(),
  /** The rest cover the last 24 hours. */
  activeUsers: z.number().int(),
  requests: z.number().int(),
  serverErrors: z.number().int(),
  slowRequests: z.number().int(),
  outbound: z.object({
    requests: z.number().int(),
    notModified: z.number().int(),
    failures: z.number().int(),
    rateLimited: z.number().int(),
  }),
  hosts: z.number().int(),
  jobs: z.object({ runs: z.number().int(), failures: z.number().int() }),
});

export const opsHostSchema = z.object({
  host: z.string(),
  requests: z.number().int(),
  ok: z.number().int(),
  notModified: z.number().int(),
  clientErrors: z.number().int(),
  serverErrors: z.number().int(),
  rateLimited: z.number().int(),
  timeouts: z.number().int(),
  networkErrors: z.number().int(),
  /** Blocked private addresses, oversized responses, redirect loops, invalid URLs. */
  other: z.number().int(),
  bytes: z.number(),
  avgMs: z.number().int(),
  peakHourRequests: z.number().int(),
  /** The host's Retry-After pause, while it lasts. */
  blockedUntil: z.iso.datetime().nullable(),
  /** Admins' minimum interval between feed checks of the host. */
  minIntervalMinutes: z.number().int().nullable(),
});

/** Admins' minimum interval between feed checks of a host. */
export const hostRuleSchema = z.object({
  /** Host and port, e.g. `example.com` or `example.com:8443`. */
  host: z.string(),
  minIntervalMinutes: z.number().int(),
  updatedAt: z.iso.datetime(),
});

export const setHostRuleRequestSchema = z.object({
  minIntervalMinutes: z.number().int().min(15).max(10_080),
});

export const opsHostsResponseSchema = z.object({
  /** Requests to one host in an hour above which an alert opens. */
  hourlyBudget: z.number().int(),
  hosts: z.array(opsHostSchema),
  hourly: z.array(
    z.object({
      hour: z.iso.datetime(),
      requests: z.number().int(),
      failures: z.number().int(),
      rateLimited: z.number().int(),
    }),
  ),
});

export const opsJobsResponseSchema = z.object({
  jobs: z.array(
    z.object({
      job: z.string(),
      runs: z.number().int(),
      failures: z.number().int(),
      avgMs: z.number().int(),
      maxMs: z.number().int(),
    }),
  ),
  hourly: z.array(
    z.object({ hour: z.iso.datetime(), runs: z.number().int(), failures: z.number().int() }),
  ),
});

export const opsUserSchema = z.object({
  id: z.number().int(),
  login: z.string(),
  role: z.string(),
  disabled: z.boolean(),
  lastSeenAt: z.iso.datetime().nullable(),
  requests7d: z.number().int(),
  requests30d: z.number().int(),
  /** Requests in 30 days by client: web, desktop, mobile, greader, ttrss, other. */
  clients: z.record(z.string(), z.number().int()),
  read7d: z.number().int(),
  read30d: z.number().int(),
});

export const opsAlertSchema = z.object({
  id: z.number().int(),
  rule: z.string(),
  subject: z.string(),
  severity: z.enum(['warning', 'critical']),
  openedAt: z.iso.datetime(),
  lastSeenAt: z.iso.datetime(),
  resolvedAt: z.iso.datetime().nullable(),
  summary: z.string(),
  details: z.record(z.string(), z.unknown()),
});

export const auditEventSchema = z.object({
  id: z.number().int(),
  at: z.iso.datetime(),
  event: z.string(),
  userId: z.number().int().nullable(),
  userLogin: z.string().nullable(),
  actorUserId: z.number().int().nullable(),
  actorLogin: z.string().nullable(),
  ip: z.string().nullable(),
  userAgent: z.string().nullable(),
  details: z.record(z.string(), z.unknown()),
});

export const auditQuerySchema = z.object({
  /** The previous page's `nextBefore`. */
  before: z.coerce.number().int().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  event: z.string().min(1).optional(),
  userId: z.coerce.number().int().optional(),
});

export const auditPageSchema = z.object({
  events: z.array(auditEventSchema),
  /** Pass as `before` for the next page; null on the last. */
  nextBefore: z.number().int().nullable(),
});

export type OpsSummary = z.infer<typeof opsSummarySchema>;
export type OpsHost = z.infer<typeof opsHostSchema>;
export type HostRule = z.infer<typeof hostRuleSchema>;
export type SetHostRuleRequest = z.infer<typeof setHostRuleRequestSchema>;
export type OpsHostsResponse = z.infer<typeof opsHostsResponseSchema>;
export type OpsJobsResponse = z.infer<typeof opsJobsResponseSchema>;
export type OpsUser = z.infer<typeof opsUserSchema>;
export type OpsAlert = z.infer<typeof opsAlertSchema>;
export type AuditEvent = z.infer<typeof auditEventSchema>;
export type AuditQuery = Partial<Record<'before' | 'limit' | 'userId', number>> & {
  event?: string;
};
export type AuditPage = z.infer<typeof auditPageSchema>;
