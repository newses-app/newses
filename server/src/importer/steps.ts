import type { ImportStep } from './importer.ts';
import { categoriesStep } from './steps/categories.ts';
import { entriesStep } from './steps/entries.ts';
import { feedsStep } from './steps/feeds.ts';
import { labelsStep } from './steps/labels.ts';
import { prefsStep } from './steps/prefs.ts';
import { sharingStep } from './steps/sharing.ts';
import { tagsStep } from './steps/tags.ts';
import { usersStep } from './steps/users.ts';

/** The import's steps, in the order they run: later steps map onto rows earlier ones import. */
export const IMPORT_STEPS: readonly ImportStep[] = [
  usersStep,
  categoriesStep,
  feedsStep,
  prefsStep,
  entriesStep,
  labelsStep,
  tagsStep,
  sharingStep,
];
