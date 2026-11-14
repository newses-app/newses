// Per-package coverage from Vitest's `json-summary` report, for `pnpm coverage:status`; nothing the
// apps run imports it.

export const COVERAGE_METRICS = ['lines', 'statements', 'functions', 'branches'] as const;
export type CoverageMetric = (typeof COVERAGE_METRICS)[number];

export interface Counts {
  covered: number;
  total: number;
}

export type CoverageTotals = Record<CoverageMetric, Counts>;

/** The `json-summary` report: `total`, then each file by its absolute path. */
export type CoverageSummary = Record<string, Record<CoverageMetric, Counts>>;

const emptyTotals = (): CoverageTotals => ({
  lines: { covered: 0, total: 0 },
  statements: { covered: 0, total: 0 },
  functions: { covered: 0, total: 0 },
  branches: { covered: 0, total: 0 },
});

function add(into: CoverageTotals, from: Record<CoverageMetric, Counts>) {
  for (const metric of COVERAGE_METRICS) {
    into[metric].covered += from[metric].covered;
    into[metric].total += from[metric].total;
  }
}

/**
 * Totals per package (the file's first folder under `root`), in name order, then the overall total.
 * Files outside `root` are left out.
 */
export function packageCoverage(
  summary: CoverageSummary,
  root: string,
): [string, CoverageTotals][] {
  const prefix = root.endsWith('/') ? root : `${root}/`;
  const packages = new Map<string, CoverageTotals>();
  const overall = emptyTotals();
  for (const [path, counts] of Object.entries(summary)) {
    if (path === 'total' || !path.startsWith(prefix)) continue;
    const name = path.slice(prefix.length).split('/')[0] ?? '';
    let totals = packages.get(name);
    if (!totals) packages.set(name, (totals = emptyTotals()));
    add(totals, counts);
    add(overall, counts);
  }
  return [
    ...[...packages].sort(([a], [b]) => a.localeCompare(b)),
    ['total', overall] as [string, CoverageTotals],
  ];
}

const percent = ({ covered, total }: Counts) =>
  total === 0 ? '–' : `${(Math.floor((covered / total) * 1000) / 10).toFixed(1)}%`;

/** A Markdown table: a row per package and the total, each metric as its percentage and counts. */
export function coverageTable(rows: [string, CoverageTotals][]): string {
  const header = ['Package', 'Lines', 'Statements', 'Functions', 'Branches'];
  const lines = rows.map(([name, totals]) => [
    name === 'total' ? '**Total**' : name,
    ...COVERAGE_METRICS.map(
      (m) => `${percent(totals[m])} (${String(totals[m].covered)}/${String(totals[m].total)})`,
    ),
  ]);
  return [header, header.map(() => '---'), ...lines]
    .map((cells) => `| ${cells.join(' | ')} |`)
    .join('\n');
}
