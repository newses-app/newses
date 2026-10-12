// Starts the OpenTelemetry SDK; loaded by register.ts only when export is on.
import { basename } from 'node:path';
import { PgInstrumentation } from '@opentelemetry/instrumentation-pg';
import { PinoInstrumentation } from '@opentelemetry/instrumentation-pino';
import { RuntimeNodeInstrumentation } from '@opentelemetry/instrumentation-runtime-node';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { register } from 'import-in-the-middle/register-hooks.mjs';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from '@opentelemetry/semantic-conventions';
import { onTelemetryShutdown } from './index.ts';

/** `server`, `worker`, `migrate`, or `cli`, from the entrypoint being run. */
function role(): string {
  return basename(process.argv[1] ?? 'server').replace(/\.[cm]?[jt]s$/, '');
}

/**
 * Traces, metrics, and logs go over OTLP to OTEL_EXPORTER_OTLP_ENDPOINT; the standard OTEL_*
 * variables (sampler, export interval, `OTEL_LOGS_EXPORTER=none`, ...) apply.
 */
export function startTelemetry(): void {
  // Lets the instrumentations patch the modules they need when loaded with `import`.
  register({ include: ['pg', 'pino'] });

  const sdk = new NodeSDK({
    resource: resourceFromAttributes({
      [ATTR_SERVICE_NAME]: process.env.OTEL_SERVICE_NAME ?? `newses-${role()}`,
      [ATTR_SERVICE_VERSION]: process.env.NEWSES_VERSION ?? 'dev',
    }),
    instrumentations: [
      // Only queries inside a traced request or job: pg-boss polls the database constantly.
      // Statements are parameterised, and parameter values are never recorded.
      new PgInstrumentation({ requireParentSpan: true, enhancedDatabaseReporting: false }),
      // Sends log records over OTLP; the logger adds trace ids itself (runtime.ts).
      new PinoInstrumentation({ disableLogCorrelation: true }),
      new RuntimeNodeInstrumentation(),
    ],
  });
  sdk.start();
  onTelemetryShutdown(() => sdk.shutdown());
}
