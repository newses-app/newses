/** A letter struck by a worn typebar: off the baseline and turned, by amounts fixed per letter. */
export interface JitterLetter {
  text: string;
  /** Vertical offset, in em. */
  y: number;
  /** Rotation, in degrees. */
  rotate: number;
  /** Its place in the text, so letters can be struck in turn. */
  index: number;
}

/** A word's letters, or the white space between words. */
export type JitterPart = JitterLetter[] | string;

/** Scripts whose letters stand apart, so setting them one by one breaks no joins or shaping. */
const SEPARATE_LETTERS =
  /^[\p{Script=Latin}\p{Script=Greek}\p{Script=Cyrillic}\p{Script=Common}\p{Script=Inherited}]*$/u;
const MAX_Y = 0.08;
const MAX_ROTATE = 4;

const segmenter =
  typeof Intl.Segmenter === 'function'
    ? new Intl.Segmenter(undefined, { granularity: 'grapheme' })
    : null;
const graphemes = (word: string): string[] =>
  segmenter ? Array.from(segmenter.segment(word), ({ segment }) => segment) : Array.from(word);

/** A number in [-1, 1) that depends only on its seed. */
function noise(seed: number): number {
  let x = Math.imul(seed ^ (seed >>> 16), 0x45d9f3b);
  x = Math.imul(x ^ (x >>> 16), 0x45d9f3b);
  x ^= x >>> 16;
  return ((x >>> 0) / 0x100000000) * 2 - 1;
}

/**
 * The text as words of jittered letters, or null when it is in a script whose letters join, or
 * has no letters at all.
 */
export function jitterLetters(text: string): JitterPart[] | null {
  if (!text.trim() || !SEPARATE_LETTERS.test(text)) return null;
  let index = 0;
  return text
    .split(/(\s+)/)
    .filter(Boolean)
    .map((part) => {
      if (/^\s+$/.test(part)) return part;
      return graphemes(part).map((letter) => {
        const seed = index * 0x9e3779b1 + (letter.codePointAt(0) ?? 0);
        const jittered = {
          text: letter,
          y: Math.round(noise(seed) * MAX_Y * 1000) / 1000,
          rotate: Math.round(noise(seed + 1) * MAX_ROTATE * 10) / 10,
          index,
        };
        index += 1;
        return jittered;
      });
    });
}
