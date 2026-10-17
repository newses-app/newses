import { describe, expect, it } from 'vitest';
import { anchoredScrollTop, capturePosition } from './list-position.ts';

const rows = [
  { key: '1', top: -180, bottom: -100 },
  { key: '2', top: -100, bottom: -20 },
  { key: '3', top: -20, bottom: 60 },
  { key: '4', top: 60, bottom: 140 },
];

describe('capturePosition', () => {
  it('anchors on the first row not scrolled entirely above the view', () => {
    expect(capturePosition(rows, 0, 500)).toEqual({ key: '3', offset: -20, scrollTop: 500 });
    expect(capturePosition(rows, 60, 500)).toEqual({ key: '4', offset: 0, scrollTop: 500 });
  });

  it('keeps only the scroll offset without a row in view', () => {
    expect(capturePosition([], 0, 0)).toEqual({ key: null, offset: 0, scrollTop: 0 });
    expect(capturePosition(rows, 200, 900)).toEqual({ key: null, offset: 0, scrollTop: 900 });
  });
});

describe('anchoredScrollTop', () => {
  it('scrolls the row back to its distance from the view top', () => {
    const position = { key: '3', offset: -20, scrollTop: 500 };
    // Unscrolled, with the row 480px below the view top: the saved place.
    expect(anchoredScrollTop(position, 0, 560, 80)).toBe(500);
    // Two 80px rows arrived above it since.
    expect(anchoredScrollTop(position, 0, 720, 80)).toBe(660);
    // Already scrolled part of the way, after one row arrived.
    expect(anchoredScrollTop(position, 300, 340, 80)).toBe(580);
  });
});
