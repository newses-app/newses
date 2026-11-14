// `pnpm coverage:status`: coverage per package and overall from the last `pnpm test:coverage`,
// printed and written to `coverage/summary.md`. It reports, and never fails on low coverage.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { type CoverageSummary, coverageTable, packageCoverage } from './coverage-summary.ts';

const root = new URL('../../', import.meta.url);
const summary = JSON.parse(
  readFileSync(new URL('coverage/coverage-summary.json', root), 'utf8'),
) as CoverageSummary;

const table = coverageTable(packageCoverage(summary, fileURLToPath(root)));
console.log(table);
writeFileSync(new URL('coverage/summary.md', root), `# Unit test coverage\n\n${table}\n`);
