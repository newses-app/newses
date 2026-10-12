import { context, propagation, trace } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { W3CTraceContextPropagator } from '@opentelemetry/core';
import {
  InMemorySpanExporter,
  type ReadableSpan,
  SimpleSpanProcessor,
  TracerProvider,
} from '@opentelemetry/sdk-trace';

/** Registers an in-memory tracer for the test file; `stop` unregisters it. */
export function recordSpans(): {
  spans: () => ReadableSpan[];
  reset: () => void;
  stop: () => void;
} {
  const exporter = new InMemorySpanExporter();
  context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
  propagation.setGlobalPropagator(new W3CTraceContextPropagator());
  trace.setGlobalTracerProvider(
    new TracerProvider({ spanProcessors: [new SimpleSpanProcessor({ exporter })] }),
  );
  return {
    spans: () => exporter.getFinishedSpans(),
    reset: () => {
      exporter.reset();
    },
    stop: () => {
      trace.disable();
      propagation.disable();
      context.disable();
    },
  };
}

/** Every span name and attribute value as one string, to search for leaked secrets. */
export function spanText(spans: ReadableSpan[]): string {
  return JSON.stringify(spans.map((span) => [span.name, span.attributes, span.events]));
}
