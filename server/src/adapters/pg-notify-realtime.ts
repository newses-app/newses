import type pg from 'pg';
import type { Logger, Realtime, RealtimeEvent } from '../core/ports.ts';

const CHANNEL = 'realtime';
// Postgres rejects NOTIFY payloads of 8000 bytes or more.
const MAX_PAYLOAD_BYTES = 7900;
const RECONNECT_DELAY_MS = 2000;

interface Message {
  u: number;
  e: RealtimeEvent;
}

/**
 * Realtime over Postgres LISTEN/NOTIFY, so events published by the worker reach the server's
 * subscribers. Publishing needs no start(); subscribers only receive events after start().
 */
export class PgNotifyRealtime implements Realtime {
  readonly #pool: pg.Pool;
  readonly #logger: Logger;
  readonly #listeners = new Map<number, Set<(event: RealtimeEvent) => void>>();
  #client: pg.PoolClient | undefined;
  #reconnectTimer: NodeJS.Timeout | undefined;
  #stopped = false;

  constructor(pool: pg.Pool, logger: Logger) {
    this.#pool = pool;
    this.#logger = logger;
  }

  async start(): Promise<void> {
    this.#stopped = false;
    const client = await this.#pool.connect();
    client.on('notification', (msg) => {
      if (msg.channel === CHANNEL && msg.payload) this.#dispatch(msg.payload);
    });
    client.on('error', (err) => {
      this.#logger.warn({ err }, 'Realtime listener connection lost');
      this.#reconnect();
    });
    try {
      await client.query(`LISTEN ${CHANNEL}`);
    } catch (err) {
      client.release(true);
      throw err;
    }
    this.#client = client;
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    clearTimeout(this.#reconnectTimer);
    const client = this.#client;
    this.#client = undefined;
    if (client) {
      await client.query(`UNLISTEN ${CHANNEL}`).catch(() => undefined);
      client.release();
    }
  }

  async publish(userId: number, event: RealtimeEvent): Promise<void> {
    const payload = JSON.stringify({ u: userId, e: event } satisfies Message);
    if (Buffer.byteLength(payload) > MAX_PAYLOAD_BYTES) throw new Error('Realtime event too large');
    await this.#pool.query('SELECT pg_notify($1, $2)', [CHANNEL, payload]);
  }

  subscribe(userId: number, listener: (event: RealtimeEvent) => void): () => void {
    let listeners = this.#listeners.get(userId);
    if (!listeners) {
      listeners = new Set();
      this.#listeners.set(userId, listeners);
    }
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) this.#listeners.delete(userId);
    };
  }

  #dispatch(payload: string): void {
    let message: Message;
    try {
      message = JSON.parse(payload) as Message;
    } catch (err) {
      this.#logger.warn({ err }, 'Ignoring malformed realtime payload');
      return;
    }
    for (const listener of this.#listeners.get(message.u) ?? []) listener(message.e);
  }

  #reconnect(): void {
    this.#client?.release(true);
    this.#client = undefined;
    if (this.#stopped || this.#reconnectTimer) return;
    this.#reconnectTimer = setTimeout(() => {
      this.#reconnectTimer = undefined;
      if (this.#stopped) return;
      this.start().catch((err: unknown) => {
        this.#logger.warn({ err }, 'Realtime listener reconnect failed');
        this.#reconnect();
      });
    }, RECONNECT_DELAY_MS);
  }
}
