import { describe, expect, it } from 'vitest';
import { afterSuccess, afterThrottle, effectiveInterval, jittered } from './schedule.ts';

const none = { base: 1800, hint: null, slowdown: null, siteMinimum: null };

describe('effectiveInterval', () => {
  it('takes the longest input and says which set it, ties going to the subscribers', () => {
    expect(effectiveInterval(none, 900)).toEqual({ seconds: 1800, reason: 'subscribers' });
    expect(effectiveInterval({ ...none, hint: 1800 }, 900).reason).toBe('subscribers');
    expect(effectiveInterval({ ...none, hint: 7200 }, 900)).toEqual({
      seconds: 7200,
      reason: 'publisher',
    });
    expect(effectiveInterval({ ...none, hint: 7200, slowdown: 14_400 }, 900)).toEqual({
      seconds: 14_400,
      reason: 'slowdown',
    });
    expect(effectiveInterval({ ...none, slowdown: 3600, siteMinimum: 21_600 }, 900)).toEqual({
      seconds: 21_600,
      reason: 'siteMinimum',
    });
  });

  it('caps publisher hints at a day', () => {
    expect(effectiveInterval({ ...none, hint: 10 * 86_400 }, 900).seconds).toBe(86_400);
  });

  it('is unscheduled when every subscription is paused, using the fallback', () => {
    expect(effectiveInterval({ ...none, base: null }, 900)).toEqual({
      seconds: 900,
      reason: 'unscheduled',
    });
  });
});

describe('jittered', () => {
  it('adds up to 10 %', () => {
    expect(jittered(1800, 0)).toBe(1800);
    expect(jittered(1800, 1)).toBe(1980);
  });
});

describe('afterThrottle', () => {
  it('doubles the longer of the slowdown and the interval, up to a day', () => {
    expect(afterThrottle(null, 1800)).toBe(3600);
    expect(afterThrottle(3600, 1800)).toBe(7200);
    expect(afterThrottle(3600, 14_400)).toBe(28_800);
    expect(afterThrottle(64_800, 1800)).toBe(86_400);
  });
});

describe('afterSuccess', () => {
  it('halves the slowdown after five successes and clears it once it no longer applies', () => {
    let state: { slowdown: number | null; okCount: number } = { slowdown: 7200, okCount: 0 };
    for (let i = 0; i < 4; i++) state = afterSuccess(state.slowdown, state.okCount, 1800);
    expect(state).toEqual({ slowdown: 7200, okCount: 4 });
    state = afterSuccess(state.slowdown, state.okCount, 1800);
    expect(state).toEqual({ slowdown: 3600, okCount: 0 });
    for (let i = 0; i < 5; i++) state = afterSuccess(state.slowdown, state.okCount, 1800);
    expect(state).toEqual({ slowdown: null, okCount: 0 });
    expect(afterSuccess(null, 0, 1800)).toEqual({ slowdown: null, okCount: 0 });
  });
});
