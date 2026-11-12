import { type SearchLanguage, searchLanguage } from '@newses/shared/client';

/** Reduces a folded word to its stem. */
export type Stem = (word: string) => string;

// One chunk per language, loaded when a search first needs it.
const LOADERS: Record<SearchLanguage, () => Promise<{ stemmer: Stem }>> = {
  arabic: () => import('@orama/stemmers/arabic'),
  armenian: () => import('@orama/stemmers/armenian'),
  danish: () => import('@orama/stemmers/danish'),
  dutch: () => import('@orama/stemmers/dutch'),
  english: () => import('@orama/stemmers/english'),
  finnish: () => import('@orama/stemmers/finnish'),
  french: () => import('@orama/stemmers/french'),
  german: () => import('@orama/stemmers/german'),
  greek: () => import('@orama/stemmers/greek'),
  hungarian: () => import('@orama/stemmers/hungarian'),
  indonesian: () => import('@orama/stemmers/indonesian'),
  irish: () => import('@orama/stemmers/irish'),
  italian: () => import('@orama/stemmers/italian'),
  lithuanian: () => import('@orama/stemmers/lithuanian'),
  nepali: () => import('@orama/stemmers/nepali'),
  norwegian: () => import('@orama/stemmers/norwegian'),
  portuguese: () => import('@orama/stemmers/portuguese'),
  romanian: () => import('@orama/stemmers/romanian'),
  russian: () => import('@orama/stemmers/russian'),
  serbian: () => import('@orama/stemmers/serbian'),
  spanish: () => import('@orama/stemmers/spanish'),
  swedish: () => import('@orama/stemmers/swedish'),
  tamil: () => import('@orama/stemmers/tamil'),
  turkish: () => import('@orama/stemmers/turkish'),
};

const loaded = new Map<SearchLanguage, Promise<Stem | null>>();

/** The stemmer of a language; null when it cannot be loaded (offline before it was cached). */
export function loadStemmer(language: SearchLanguage): Promise<Stem | null> {
  let stem = loaded.get(language);
  if (!stem) {
    stem = LOADERS[language]()
      .then((m) => m.stemmer)
      .catch(() => {
        loaded.delete(language);
        return null;
      });
    loaded.set(language, stem);
  }
  return stem;
}

/** The stemmers of the languages among `tags` that search has one for. */
export async function stemmersFor(tags: Iterable<string | null | undefined>): Promise<Stem[]> {
  const languages = new Set<SearchLanguage>();
  for (const tag of tags) {
    const language = searchLanguage(tag);
    if (language) languages.add(language);
  }
  const stems = await Promise.all([...languages].sort().map(loadStemmer));
  return stems.filter((s) => s !== null);
}
