import { describe, expect, it } from 'vitest';
import { defineComponent } from 'vue';
import { mountWithPlugins } from '../test/mount.ts';
import { useDurations } from './useDurations.ts';

function durations() {
  let result!: ReturnType<typeof useDurations>;
  mountWithPlugins(
    defineComponent({
      setup() {
        result = useDurations();
        return () => null;
      },
    }),
  );
  return result;
}

describe('useDurations', () => {
  it('words each interval as a whole sentence', () => {
    const titles = durations().intervalItems.value.map((item) => item.title);
    expect(titles).toEqual([
      'Default',
      'Every 15 minutes',
      'Every 30 minutes',
      'Every hour',
      'Every 2 hours',
      'Every 4 hours',
      'Every 12 hours',
      'Every day',
      'Every week',
    ]);
  });

  it('words each purge age as a whole sentence', () => {
    const titles = durations().purgeItems.value.map((item) => item.title);
    expect(titles.slice(0, 2)).toEqual(['Default', 'Older than 7 days']);
    expect(titles.at(-1)).toBe('Never');
  });

  it('keeps durations as nouns for the sentences around them', () => {
    expect(durations().duration(60)).toBe('one hour');
    expect(durations().duration(120)).toBe('2 hours');
  });
});
