import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Logger } from '../core/ports.ts';
import { IntervalScheduler } from './interval-scheduler.ts';

const logger: Logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe('IntervalScheduler', () => {
  it('runs on start and then after each interval', async () => {
    const scheduler = new IntervalScheduler(logger);
    const task = vi.fn(() => Promise.resolve());
    scheduler.every('tick', 10, task);
    scheduler.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(task).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(25_000);
    expect(task).toHaveBeenCalledTimes(3);
    await scheduler.stop();
  });

  it('never overlaps runs of the same task', async () => {
    const scheduler = new IntervalScheduler(logger);
    let finish: (() => void) | undefined;
    const task = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    scheduler.every('slow', 10, task);
    scheduler.start();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(task).toHaveBeenCalledTimes(1);
    finish?.();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(task).toHaveBeenCalledTimes(2);
    finish?.();
    await scheduler.stop();
  });

  it('logs failures and keeps scheduling', async () => {
    const scheduler = new IntervalScheduler(logger);
    const task = vi.fn(() => Promise.reject(new Error('boom')));
    scheduler.every('failing', 10, task);
    scheduler.start();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(task).toHaveBeenCalledTimes(2);
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ task: 'failing' }),
      'Scheduled task failed',
    );
    await scheduler.stop();
  });

  it('waits for running tasks on stop and does not reschedule', async () => {
    const scheduler = new IntervalScheduler(logger);
    let finish: (() => void) | undefined;
    const task = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    scheduler.every('slow', 10, task);
    scheduler.start();
    let stopped = false;
    const stopping = scheduler.stop().then(() => (stopped = true));
    await vi.advanceTimersByTimeAsync(0);
    expect(stopped).toBe(false);
    finish?.();
    await stopping;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(task).toHaveBeenCalledTimes(1);
  });
});
