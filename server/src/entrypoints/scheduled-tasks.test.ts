import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Jobs } from '../core/jobs.ts';
import type { JobQueue } from '../core/ports.ts';
import { silentLogger } from '../test/fakes.ts';
import {
  createTickHandler,
  scheduleWorkerTasks,
  type TaskDeps,
  TICK_COMPACT_BUDGET_MS,
  WORKER_COMPACT_BUDGET_MS,
  workJobs,
} from './scheduled-tasks.ts';

const setOpenAlerts = vi.hoisted(() => vi.fn());
vi.mock('../telemetry/index.ts', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  setOpenAlerts,
}));

const NOW = Date.parse('2026-11-14T12:00:00Z');

/** Services whose calls are logged in order, each answering `answer`. */
function services(options: { archive?: boolean; failing?: string } = {}) {
  const calls: string[] = [];
  const jobs: { job: string; ok: boolean }[] = [];
  const step =
    <T>(name: string, answer: T) =>
    (...args: unknown[]) => {
      calls.push(args.length > 0 ? `${name} ${JSON.stringify(args)}` : name);
      return name === options.failing
        ? Promise.reject(new Error(`${name} failed`))
        : Promise.resolve(answer);
    };
  const logger = { ...silentLogger, debug: vi.fn(), info: vi.fn(), warn: vi.fn() };
  const deps: TaskDeps = {
    feeds: {
      updater: { dispatchDue: step('dispatchDue', 3), updateMany: step('updateMany', undefined) },
      favicons: { refresh: step('refresh', undefined) },
      fullText: { runJob: step('runJob', undefined) },
      push: { flush: step('push.flush', 2) },
      images: {
        keep: step('images.keep', { indexed: 1, fetched: 0 }),
        purge: step('images.purge', 4),
      },
      purger: { purge: step('purge', { entries: 5 }) as TaskDeps['feeds']['purger']['purge'] },
      rateLimits: { prune: step('rateLimits.prune', undefined) },
    },
    sessions: { pruneExpired: step('sessions.prune', undefined) },
    throttle: { prune: step('throttle.prune', undefined) },
    sync: { pruneTombstones: step('tombstones.prune', 0) },
    digest: { sendDue: step('digest.send', 1) },
    ops: {
      recorder: {
        recordJob: (run) => void jobs.push({ job: run.job, ok: run.ok }),
        flush: step('stats.flush', undefined),
      },
      checker: { run: step('checker.run', { open: 1 }) as TaskDeps['ops']['checker']['run'] },
      prune: step('ops.prune', { stats: 0, audit: 0 }),
    },
    plugins: { storage: { prune: step('plugins.prune', 0) } },
    archive: options.archive ? { compact: step('compact', 2) } : null,
    logger,
  };
  return { deps, calls, jobs, logger };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
  setOpenAlerts.mockClear();
});

describe('workJobs', () => {
  type Handler = (data: object) => Promise<void>;

  it('handles each queue job, tracking its runs', async () => {
    const handlers = new Map<string, { handler: Handler; concurrency?: number }>();
    const queue: Pick<JobQueue<Jobs>, 'work'> = {
      work: (name, handler, options) => {
        handlers.set(name, {
          handler: handler as Handler,
          ...(options?.concurrency && { concurrency: options.concurrency }),
        });
        return Promise.resolve();
      },
    };
    const { deps, calls, jobs } = services();
    await workJobs(queue, deps);
    expect([...handlers].map(([name, { concurrency }]) => [name, concurrency])).toEqual([
      ['feed.fetch', 8],
      ['feed.favicon', 2],
      ['entry.extract', 2],
    ]);

    const run = (name: string, data: object) => handlers.get(name)?.handler(data);
    await run('feed.fetch', { feedSourceIds: [1, 2] });
    // A job from before host batching: its source is picked up by a later dispatch.
    await run('feed.fetch', { feedSourceId: 3 });
    await run('feed.favicon', { feedSourceId: 7 });
    await run('entry.extract', { feedSourceId: 4 });
    expect(calls).toEqual([
      'updateMany [[1,2]]',
      'updateMany [[]]',
      'refresh [7]',
      'runJob [{"feedSourceId":4}]',
    ]);
    expect(jobs.map((j) => j.job)).toEqual([
      'feed.fetch',
      'feed.fetch',
      'feed.favicon',
      'entry.extract',
    ]);
  });
});

describe('scheduleWorkerTasks', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'worker-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  function schedule(options: Parameters<typeof services>[0] = {}, heartbeat = join(dir, 'beat')) {
    const tasks = new Map<string, { seconds: number; run: () => Promise<void> }>();
    const scheduler = {
      every: (name: string, seconds: number, run: () => Promise<void>) => {
        tasks.set(name, { seconds, run });
      },
    };
    const fake = services(options);
    scheduleWorkerTasks(scheduler, fake.deps, heartbeat);
    const run = (name: string) => tasks.get(name)?.run() ?? Promise.reject(new Error(name));
    return { ...fake, tasks, run };
  }

  it('runs each task at its interval, compacting the archive only with one', () => {
    const intervals = (tasks: Map<string, { seconds: number }>) =>
      Object.fromEntries([...tasks].map(([name, { seconds }]) => [name, seconds]));
    expect(intervals(schedule().tasks)).toEqual({
      'feeds.dispatch': 60,
      'push.flush': 300,
      'digest.send': 300,
      'images.keep': 300,
      'feeds.purge': 21_600,
      'auth.prune': 3600,
      'ops.check': 300,
    });
    expect(intervals(schedule({ archive: true }).tasks)['archive.compact']).toBe(86_400);
  });

  it('dispatches due feeds, then writes the heartbeat', async () => {
    const { run, calls, jobs } = schedule();
    await run('feeds.dispatch');
    expect(calls).toEqual(['dispatchDue']);
    expect(await readFile(join(dir, 'beat'), 'utf8')).toBe(new Date(NOW).toISOString());
    expect(jobs).toEqual([{ job: 'feeds.dispatch', ok: true }]);
  });

  it('only warns when the heartbeat cannot be written', async () => {
    const { run, logger, jobs } = schedule({}, join(dir, 'missing', 'beat'));
    await run('feeds.dispatch');
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error) as unknown }),
      'Could not write the worker heartbeat',
    );
    expect(jobs).toEqual([{ job: 'feeds.dispatch', ok: true }]);
  });

  it('purges, prunes, pushes, sends digests, and keeps images', async () => {
    const { run, calls } = schedule();
    await run('feeds.purge');
    await run('auth.prune');
    await run('push.flush');
    await run('digest.send');
    await run('images.keep');
    expect(calls).toEqual([
      'purge',
      'images.purge',
      'tombstones.prune',
      'ops.prune',
      'plugins.prune',
      'sessions.prune',
      'throttle.prune',
      'rateLimits.prune',
      'push.flush',
      'digest.send',
      'images.keep [120000]',
    ]);
  });

  it('writes the statistics before checking the alert rules, and counts open alerts', async () => {
    const { run, calls } = schedule();
    await run('ops.check');
    expect(calls).toEqual(['stats.flush', 'checker.run']);
    expect(setOpenAlerts).toHaveBeenCalledWith(1);
  });

  it('compacts the archive within its budget', async () => {
    const { run, calls } = schedule({ archive: true });
    await run('archive.compact');
    expect(calls).toEqual([`compact [${String(NOW + WORKER_COMPACT_BUDGET_MS)}]`]);
  });

  it('records a failed run as failed', async () => {
    const { run, jobs } = schedule({ failing: 'sessions.prune' });
    await expect(run('auth.prune')).rejects.toThrow('sessions.prune failed');
    expect(jobs).toEqual([{ job: 'auth.prune', ok: false }]);
  });
});

describe('createTickHandler', () => {
  it('dispatches, then pushes, sends digests, checks the alert rules, and keeps images, each tracked', async () => {
    const { deps, calls, jobs } = services();
    await createTickHandler(deps)({ task: 'dispatch' });
    expect(calls).toEqual([
      'dispatchDue',
      'push.flush',
      'digest.send',
      'stats.flush',
      'checker.run',
      'images.keep [120000]',
      'stats.flush',
    ]);
    expect(jobs.map((j) => j.job)).toEqual([
      'push.flush',
      'digest.send',
      'ops.check',
      'images.keep',
      'feeds.dispatch',
    ]);
  });

  it('runs the purge, auth prune, and compaction schedules', async () => {
    const { deps, calls, jobs, logger } = services({ archive: true });
    const handle = createTickHandler(deps);
    await handle({ task: 'purge' });
    await handle({ task: 'auth.prune' });
    await handle({ task: 'archive.compact' });
    expect(calls).toEqual([
      'purge',
      'images.purge',
      'tombstones.prune',
      'ops.prune',
      'plugins.prune',
      'stats.flush',
      'sessions.prune',
      'throttle.prune',
      'rateLimits.prune',
      'stats.flush',
      `compact [${String(NOW + TICK_COMPACT_BUDGET_MS)}]`,
      'stats.flush',
    ]);
    expect(jobs.map((j) => j.job)).toEqual(['feeds.purge', 'auth.prune', 'archive.compact']);
    expect(logger.info).toHaveBeenLastCalledWith({ months: 2 }, 'Compacted the archive');
  });

  it('compacts nothing without an archive', async () => {
    const { deps, logger } = services();
    await createTickHandler(deps)({ task: 'archive.compact' });
    expect(logger.info).toHaveBeenLastCalledWith({ months: 0 }, 'Compacted the archive');
  });

  it("writes the run's statistics even when it fails", async () => {
    const { deps, calls, jobs } = services({ failing: 'purge' });
    await expect(createTickHandler(deps)({ task: 'purge' })).rejects.toThrow('purge failed');
    expect(calls).toEqual(['purge', 'stats.flush']);
    expect(jobs).toEqual([{ job: 'feeds.purge', ok: false }]);
  });
});
