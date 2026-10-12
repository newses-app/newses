import { SpanKind } from '@opentelemetry/api';
import type { SQSEvent } from 'aws-lambda';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { OpsServices } from '../../core/ops/index.ts';
import type { Logger } from '../../core/ports.ts';
import { createTestDatabase, type TestDatabase } from '../../test/database.ts';
import { recordSpans } from '../../test/tracing.ts';
import { sqsHandler, trackPoolUse } from './runtime.ts';

let database: TestDatabase;
let tracing: ReturnType<typeof recordSpans>;

beforeAll(async () => {
  database = await createTestDatabase({ migrate: false });
  tracing = recordSpans();
});

afterAll(async () => {
  tracing.stop();
  await database.drop();
});

describe('trackPoolUse', () => {
  it('reports whether the pool handed out a connection since the last reset', async () => {
    const tracker = trackPoolUse(database.pool);
    expect(tracker.used()).toBe(false);
    await database.pool.query('SELECT 1');
    expect(tracker.used()).toBe(true);
    tracker.reset();
    expect(tracker.used()).toBe(false);
  });
});

describe('sqsHandler', () => {
  it('traces each job in its own trace, linked to the trace that queued it', async () => {
    const producer = { traceId: '0af7651916cd43dd8448eb211c80319c', spanId: 'b7ad6b7169203331' };
    const ops = { recorder: { recordJob: () => undefined, flush: () => Promise.resolve() } };
    const handler = sqsHandler(
      { logger: {} as Logger, ops: ops as unknown as OpsServices },
      'feed.fetch',
      () => Promise.resolve(),
    );
    const event = {
      Records: [
        {
          messageId: '1',
          body: '{}',
          messageAttributes: {
            traceparent: {
              dataType: 'String',
              stringValue: `00-${producer.traceId}-${producer.spanId}-01`,
            },
          },
        },
      ],
    } as unknown as SQSEvent;
    expect(await handler(event)).toEqual({ batchItemFailures: [] });
    const [span] = tracing.spans();
    expect(span?.name).toBe('job feed.fetch');
    expect(span?.kind).toBe(SpanKind.CONSUMER);
    expect(span?.spanContext().traceId).not.toBe(producer.traceId);
    expect(span?.links.map((link) => link.context)).toMatchObject([producer]);
  });
});
