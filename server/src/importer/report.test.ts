import { describe, expect, it } from 'vitest';
import { ImportReport, SHARED } from './report.ts';

describe('import report', () => {
  it('reconciles counts per user, marking rows that do not add up', () => {
    const report = new ImportReport(false);
    report.count('pat', 'feeds', { source: 3, imported: 2 });
    report.skip('pat', 'feeds', 7, 'HTTP authentication is not supported');
    report.count(SHARED, 'entries', { source: 10, imported: 10 });
    expect(report.reconciled).toBe(true);
    expect(report.format()).toBe(
      [
        'TTRSS import report',
        '',
        'pat',
        '    item     source  imported',
        '    feeds         3         2',
        '  skipped:',
        '    feeds 7: HTTP authentication is not supported',
        '',
        '(shared)',
        '    item       source  imported',
        '    entries        10        10',
      ].join('\n'),
    );
    report.count('pat', 'labels', { source: 1 });
    expect(report.reconciled).toBe(false);
    expect(report.format()).toContain('  ! labels');
  });

  it('counts archived rows towards reconciliation, in a column of their own', () => {
    const report = new ImportReport(false);
    report.count('pat', 'feeds', { source: 1, imported: 1 });
    report.count('pat', 'entries', { source: 5, imported: 3, archived: 1 });
    report.skip('pat', 'entries', 0, 'its feed was not imported');
    expect(report.reconciled).toBe(true);
    expect(report.format()).toBe(
      [
        'TTRSS import report',
        '',
        'pat',
        '    item       source  imported  archived',
        '    feeds           1         1         0',
        '    entries         5         3         1',
        '  skipped:',
        '    entries: its feed was not imported',
      ].join('\n'),
    );
  });
});
