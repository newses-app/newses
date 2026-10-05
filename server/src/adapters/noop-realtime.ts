import type { Realtime } from '../core/ports.ts';

/** Realtime where no process holds client streams open; clients poll instead. */
export class NoopRealtime implements Realtime {
  publish(): Promise<void> {
    return Promise.resolve();
  }

  subscribe(): () => void {
    return () => undefined;
  }
}
