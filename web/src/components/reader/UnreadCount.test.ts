import { describe, expect, it } from 'vitest';
import { withoutIsolates } from '../../lib/message-params.ts';
import { mountWithPlugins } from '../../test/mount.ts';
import UnreadCount from './UnreadCount.vue';

describe('UnreadCount', () => {
  it('shows the number, and says what it counts to screen readers', () => {
    const count = mountWithPlugins(UnreadCount, { props: { n: 7 } });
    expect(count.get('[aria-hidden="true"]').text()).toBe('7');
    expect(withoutIsolates(count.get('.d-sr-only').text())).toBe('7 unread');
  });
});
