/** Counts of one kind of item: rows in the source, and rows imported or already up to date. */
export interface Tally {
  source: number;
  imported: number;
}

export interface Skipped {
  item: string;
  sourceId: number;
  reason: string;
}

interface Section {
  tallies: Map<string, Tally>;
  skipped: Skipped[];
}

/** Rows not owned by a user (feed sources, entries) are reported under this name. */
export const SHARED = '(shared)';

/**
 * The reconciliation report: per TTRSS user, source and imported counts of each kind of item,
 * and every item skipped with the reason.
 */
export class ImportReport {
  readonly dryRun: boolean;
  readonly #sections = new Map<string, Section>();

  constructor(dryRun: boolean) {
    this.dryRun = dryRun;
  }

  #section(login: string): Section {
    let section = this.#sections.get(login);
    if (!section) {
      section = { tallies: new Map(), skipped: [] };
      this.#sections.set(login, section);
    }
    return section;
  }

  /** Adds to a user's counts of `item`. */
  count(login: string, item: string, counts: Partial<Tally>): void {
    const { tallies } = this.#section(login);
    const tally = tallies.get(item) ?? { source: 0, imported: 0 };
    tally.source += counts.source ?? 0;
    tally.imported += counts.imported ?? 0;
    tallies.set(item, tally);
  }

  skip(login: string, item: string, sourceId: number, reason: string): void {
    this.#section(login).skipped.push({ item, sourceId, reason });
  }

  tally(login: string, item: string): Tally {
    return this.#sections.get(login)?.tallies.get(item) ?? { source: 0, imported: 0 };
  }

  skipped(login: string): Skipped[] {
    return this.#sections.get(login)?.skipped ?? [];
  }

  /** Whether every counted item was imported or skipped with a reason. */
  get reconciled(): boolean {
    return [...this.#sections.values()].every(({ tallies, skipped }) =>
      [...tallies].every(
        ([item, t]) => t.source === t.imported + skipped.filter((s) => s.item === item).length,
      ),
    );
  }

  /** Plain-text report; rows whose counts do not reconcile are marked `!`. */
  format(): string {
    const lines = [`TTRSS import report${this.dryRun ? ' (dry run: nothing written)' : ''}`];
    for (const [login, { tallies, skipped }] of this.#sections) {
      lines.push('', login);
      if (tallies.size > 0) {
        const width = Math.max(4, ...[...tallies.keys()].map((item) => item.length));
        lines.push(
          `    ${'item'.padEnd(width)}  ${'source'.padStart(8)}  ${'imported'.padStart(8)}`,
        );
        for (const [item, t] of tallies) {
          const skips = skipped.filter((s) => s.item === item).length;
          const mark = t.source === t.imported + skips ? ' ' : '!';
          lines.push(
            `  ${mark} ${item.padEnd(width)}  ${String(t.source).padStart(8)}  ${String(t.imported).padStart(8)}`,
          );
        }
      }
      if (skipped.length > 0) {
        lines.push('  skipped:');
        for (const s of skipped) lines.push(`    ${s.item} ${String(s.sourceId)}: ${s.reason}`);
      }
    }
    return lines.join('\n');
  }
}
