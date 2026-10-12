// Preloaded with `node --import` before an entrypoint. Starts OpenTelemetry only when an OTLP
// endpoint is configured; otherwise no SDK module is loaded.
import { telemetryEnabled } from './index.ts';

if (telemetryEnabled()) {
  const { startTelemetry } = await import('./sdk.ts');
  startTelemetry();
}
