import { ApiError } from '@newses/shared/client';
import { describe, expect, it } from 'vitest';
import { withSetup } from '../test/mount.ts';
import { useErrorText } from './useErrorText.ts';

describe('useErrorText', () => {
  it("words the server's errors, and anything else generically", () => {
    const { result: errorText } = withSetup(() => useErrorText());
    expect(errorText(new ApiError(404, 'not_found', 'Label not found', null))).not.toBe(
      'Something went wrong. Please try again.',
    );
    expect(errorText(new TypeError('Failed to fetch'))).toBe(
      'Something went wrong. Please try again.',
    );
  });
});
