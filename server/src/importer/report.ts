/** Counts of one kind of item: rows in the source, and rows imported or already up to date. */
export interface Tally {
  source: number;
  imported: number;
  /** Rows kept in the cold-storage archive rather than imported; absent when none were. */
  archived?: number;
}

export interface Skipped {
  item: string;
  sourceId: number;
  reason: string;
  /** How many items this line stands for, when skipped together for one reason. */
  count: number;
}

/** Information about an imported item that does not affect reconciliation. */
export interface Note {
  item: string;
  sourceId: number;
  text: string;
}

interface Section {
  tallies: Map<string, Tally>;
  skipped: Skipped[];
  notes: Note[];
}

/** An item and its source id; rows without an id (preferences) pass 0. */
const label = ({ item, sourceId }: { item: string; sourceId: number }) =>
  sourceId ? `${item} ${String(sourceId)}` : item;

const adds = (t: Tally, skips: number) => t.source === t.imported + (t.archived ?? 0) + skips;

const skippedCount = (skipped: Skipped[], item: string) =>
  skipped.filter((s) => s.item === item).reduce((sum, s) => sum + s.count, 0);

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
      section = { tallies: new Map(), skipped: [], notes: [] };
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
    if (counts.archived) tally.archived = (tally.archived ?? 0) + counts.archived;
    tallies.set(item, tally);
  }

  skip(login: string, item: string, sourceId: number, reason: string, count = 1): void {
    if (count > 0) this.#section(login).skipped.push({ item, sourceId, reason, count });
  }

  /** Records what the import did with an item beyond counting it: adoptions, options left out. */
  note(login: string, item: string, sourceId: number, text: string): void {
    this.#section(login).notes.push({ item, sourceId, text });
  }

  notes(login: string): Note[] {
    return this.#sections.get(login)?.notes ?? [];
  }

  tally(login: string, item: string): Tally {
    return this.#sections.get(login)?.tallies.get(item) ?? { source: 0, imported: 0 };
  }

  skipped(login: string): Skipped[] {
    return this.#sections.get(login)?.skipped ?? [];
  }

  /** Whether every counted item was imported, archived, or skipped with a reason. */
  get reconciled(): boolean {
    return [...this.#sections.values()].every(({ tallies, skipped }) =>
      [...tallies].every(([item, t]) => adds(t, skippedCount(skipped, item))),
    );
  }

  /** Plain-text report; rows whose counts do not reconcile are marked `!`. */
  format(): string {
    const lines = [`TTRSS import report${this.dryRun ? ' (dry run: nothing written)' : ''}`];
    for (const [login, { tallies, skipped, notes }] of this.#sections) {
      lines.push('', login);
      if (tallies.size > 0) {
        const width = Math.max(4, ...[...tallies.keys()].map((item) => item.length));
        const archived = [...tallies.values()].some((t) => t.archived !== undefined);
        const column = (value: string | number) => `  ${String(value).padStart(8)}`;
        lines.push(
          `    ${'item'.padEnd(width)}${column('source')}${column('imported')}${archived ? column('archived') : ''}`,
        );
        for (const [item, t] of tallies) {
          const mark = adds(t, skippedCount(skipped, item)) ? ' ' : '!';
          lines.push(
            `  ${mark} ${item.padEnd(width)}${column(t.source)}${column(t.imported)}${archived ? column(t.archived ?? 0) : ''}`,
          );
        }
      }
      if (skipped.length > 0) {
        lines.push('  skipped:');
        for (const s of skipped)
          lines.push(`    ${label(s)}: ${s.reason}${s.count > 1 ? ` (${String(s.count)})` : ''}`);
      }
      if (notes.length > 0) {
        lines.push('  notes:');
        for (const n of notes) lines.push(`    ${label(n)}: ${n.text}`);
      }
    }
    return lines.join('\n');
  }
}
