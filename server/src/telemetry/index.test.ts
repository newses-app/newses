import { describe, expect, it } from 'vitest';
import { telemetryEnabled } from './index.ts';

describe('telemetryEnabled', () => {
  it('is on with an OTLP endpoint or the ADOT Lambda wrapper, unless the SDK is disabled', () => {
    expect(telemetryEnabled({})).toBe(false);
    expect(telemetryEnabled({ OTEL_EXPORTER_OTLP_ENDPOINT: 'http://lgtm:4318' })).toBe(true);
    expect(telemetryEnabled({ AWS_LAMBDA_EXEC_WRAPPER: '/opt/otel-instrument' })).toBe(true);
    expect(telemetryEnabled({ AWS_LAMBDA_EXEC_WRAPPER: '/opt/other' })).toBe(false);
    expect(
      telemetryEnabled({
        AWS_LAMBDA_EXEC_WRAPPER: '/opt/otel-instrument',
        OTEL_SDK_DISABLED: 'true',
      }),
    ).toBe(false);
  });
});
