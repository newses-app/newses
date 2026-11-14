import { describe, expect, it } from 'vitest';
import { type CoverageSummary, coverageTable, packageCoverage } from './coverage-summary.ts';

const counts = (lines: [number, number], functions: [number, number] = [0, 0]) => ({
  lines: { covered: lines[0], total: lines[1] },
  statements: { covered: lines[0], total: lines[1] },
  functions: { covered: functions[0], total: functions[1] },
  branches: { covered: 0, total: 0 },
});

const summary: CoverageSummary = {
  total: counts([999, 999]),
  '/repo/web/src/app.ts': counts([3, 4], [1, 2]),
  '/repo/server/src/a.ts': counts([5, 10], [2, 2]),
  '/repo/server/src/core/b.ts': counts([5, 10]),
  '/elsewhere/c.ts': counts([1, 1]),
};

describe('packageCoverage', () => {
  it('sums files per package in name order, then the total, ignoring the report total', () => {
    const rows = packageCoverage(summary, '/repo');
    expect(rows.map(([name]) => name)).toEqual(['server', 'web', 'total']);
    expect(rows[0]?.[1].lines).toEqual({ covered: 10, total: 20 });
    expect(rows[0]?.[1].functions).toEqual({ covered: 2, total: 2 });
    expect(rows[2]?.[1].lines).toEqual({ covered: 13, total: 24 });
    expect(rows[2]?.[1].functions).toEqual({ covered: 3, total: 4 });
  });

  it('accepts a root with a trailing slash', () => {
    expect(packageCoverage(summary, '/repo/')).toEqual(packageCoverage(summary, '/repo'));
  });
});

describe('coverageTable', () => {
  it('shows each metric as a percentage rounded down with its counts, and a dash with none', () => {
    const table = coverageTable(packageCoverage(summary, '/repo'));
    expect(table.split('\n')).toEqual([
      '| Package | Lines | Statements | Functions | Branches |',
      '| --- | --- | --- | --- | --- |',
      '| server | 50.0% (10/20) | 50.0% (10/20) | 100.0% (2/2) | – (0/0) |',
      '| web | 75.0% (3/4) | 75.0% (3/4) | 50.0% (1/2) | – (0/0) |',
      '| **Total** | 54.1% (13/24) | 54.1% (13/24) | 75.0% (3/4) | – (0/0) |',
    ]);
  });
});
