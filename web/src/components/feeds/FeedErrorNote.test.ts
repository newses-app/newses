import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mountWithPlugins } from '../../test/mount.ts';
import FeedErrorNote from './FeedErrorNote.vue';

describe('FeedErrorNote', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-04T12:00:00Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('shows when the error happened, with the exact time on hover', () => {
    const note = mountWithPlugins(FeedErrorNote, {
      props: { error: 'HTTP 404', at: '2026-10-04T09:00:00Z' },
    });
    expect(note.text()).toBe('Failed 3 hours ago: HTTP 404');
    const time = note.get('time');
    expect(time.attributes('datetime')).toBe('2026-10-04T09:00:00Z');
    expect(time.attributes('title')).toBe(
      new Intl.DateTimeFormat('en', { dateStyle: 'medium', timeStyle: 'short' }).format(
        new Date('2026-10-04T09:00:00Z'),
      ),
    );
  });

  it('says updates stopped for a disabled feed', () => {
    const note = mountWithPlugins(FeedErrorNote, {
      props: { error: 'HTTP 404', at: '2026-10-03T12:00:00Z', disabled: true },
    });
    expect(note.text()).toBe(
      'Updates stopped after repeated errors. Last failed yesterday: HTTP 404',
    );
  });

  it('shows the error alone when its time is unknown', () => {
    const note = mountWithPlugins(FeedErrorNote, { props: { error: 'HTTP 404', at: null } });
    expect(note.text()).toBe('HTTP 404');
    expect(note.find('time').exists()).toBe(false);
  });
});
