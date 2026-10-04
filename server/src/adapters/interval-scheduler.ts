import type { Logger, Scheduler } from '../core/ports.ts';

interface Task {
  name: string;
  intervalMs: number;
  run: () => Promise<void>;
  timer?: NodeJS.Timeout;
  running?: Promise<void>;
}

/** In-process Scheduler. Each task re-arms only after its run completes, so runs never overlap. */
export class IntervalScheduler implements Scheduler {
  readonly #logger: Logger;
  readonly #tasks: Task[] = [];
  #started = false;

  constructor(logger: Logger) {
    this.#logger = logger;
  }

  every(name: string, intervalSeconds: number, run: () => Promise<void>): void {
    if (this.#started) throw new Error('Register tasks before starting the scheduler');
    this.#tasks.push({ name, intervalMs: intervalSeconds * 1000, run });
  }

  start(): void {
    this.#started = true;
    for (const task of this.#tasks) this.#execute(task);
  }

  async stop(): Promise<void> {
    this.#started = false;
    for (const task of this.#tasks) clearTimeout(task.timer);
    await Promise.all(this.#tasks.flatMap((task) => (task.running ? [task.running] : [])));
  }

  #execute(task: Task): void {
    task.running = task
      .run()
      .catch((err: unknown) => {
        this.#logger.error({ err, task: task.name }, 'Scheduled task failed');
      })
      .finally(() => {
        delete task.running;
        if (this.#started) {
          task.timer = setTimeout(() => {
            this.#execute(task);
          }, task.intervalMs);
        }
      });
  }
}
