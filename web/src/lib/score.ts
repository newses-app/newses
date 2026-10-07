import { MAX_SCORE } from '@rss-reader/shared/client';

/** A whole-number score typed by the user, or null when it is not one within the allowed range. */
export function parseScore(text: string | number): number | null {
  if (typeof text === 'string' && text.trim() === '') return null;
  const value = typeof text === 'number' ? text : Number(text.trim().replace(/^−/, '-'));
  return Number.isInteger(value) && Math.abs(value) <= MAX_SCORE ? value : null;
}

/** Whether a score is highlighted under the user's threshold. */
export const isHighScore = (score: number, highlightAbove: number) =>
  score !== 0 && score > highlightAbove;
