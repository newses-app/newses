import { ApiError } from '@newses/shared/client';
import { describe, expect, it } from 'vitest';
import { i18n } from '../plugins/i18n.ts';
import { describeError } from './status.ts';

const describes = (error: unknown) => describeError(i18n.global, error);

describe('describeError', () => {
  it('says why the server refused, in the reader’s language', () => {
    const error = new ApiError(404, 'not_found', 'Label not found', null);
    expect(describes(error)).toBe('404 That no longer exists.');
  });

  it('says the server could not be reached, for a failed request or a timeout', () => {
    const unreachable = i18n.global.t('offline.unreachable');
    expect(describes(new TypeError('Failed to fetch'))).toBe(unreachable);
    expect(describes(new DOMException('Too slow', 'TimeoutError'))).toBe(unreachable);
  });

  it('keeps anything else as it is, to diagnose', () => {
    expect(describes(new RangeError('Out of range'))).toBe('RangeError: Out of range');
    expect(describes('text')).toBe('text');
  });
});
