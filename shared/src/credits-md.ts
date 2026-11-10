// CREDITS.md at the repository root, rendered from credits.ts; `pnpm credits` writes it, and a test
// fails when it is stale.
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { CREDIT_KINDS, CREDITS, type CreditKind } from './credits.ts';

export const CREDITS_MD = fileURLToPath(new URL('../../CREDITS.md', import.meta.url));

const HEADINGS: Record<CreditKind, string> = {
  framework: 'Frameworks',
  font: 'Fonts',
  icons: 'Icons',
  palette: 'Theme palettes',
  data: 'Data',
  translations: 'Translations',
};

export function creditsMarkdown(): string {
  const sections = CREDIT_KINDS.map((kind) => {
    const rows = Object.values(CREDITS)
      .filter((credit) => credit.kind === kind)
      .map(
        (credit) => `| [${credit.name}](${credit.url}) | ${credit.author} | ${credit.license} |`,
      );
    return [`## ${HEADINGS[kind]}`, '', '| Work | By | Licence |', '|---|---|---|', ...rows].join(
      '\n',
    );
  });
  return [
    '# Credits',
    '',
    'Newses is built on the work of others. Each app lists every package it bundles, with its licence, under Settings → About.',
    '',
    '<!-- Generated from shared/src/credits.ts by `pnpm credits`; edit that file instead. -->',
    '',
    sections.join('\n\n'),
    '',
  ].join('\n');
}

if (import.meta.main) writeFileSync(CREDITS_MD, creditsMarkdown());
