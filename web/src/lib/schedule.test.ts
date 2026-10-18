import { describe, expect, it } from 'vitest';
import { scheduleMessage } from './schedule.ts';

describe('scheduleMessage', () => {
  it('names the reason with the interval in effect', () => {
    expect(scheduleMessage({ intervalReason: 'shared', effectiveIntervalMinutes: 30 })).toEqual({
      key: 'feeds.schedule.shared',
      minutes: 30,
    });
    expect(scheduleMessage({ intervalReason: 'paused', effectiveIntervalMinutes: null })).toEqual({
      key: 'feeds.schedule.paused',
      minutes: null,
    });
  });

  it('says nothing before the first check or against older servers', () => {
    expect(scheduleMessage({ intervalReason: null, effectiveIntervalMinutes: null })).toBeNull();
    expect(scheduleMessage({})).toBeNull();
  });
});
