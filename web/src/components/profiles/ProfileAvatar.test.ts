import type { Profile } from '@newses/shared';
import { describe, expect, it } from 'vitest';
import { mountWithPlugins } from '../../test/mount.ts';
import ProfileAvatar from './ProfileAvatar.vue';

const profile = (fields: Partial<Profile>): Profile => ({
  id: 'a1b2',
  serverUrl: 'https://reader.example',
  userId: null,
  login: null,
  serverName: null,
  label: null,
  signedIn: false,
  ...fields,
});

const avatar = (fields: Partial<Profile>) =>
  mountWithPlugins(ProfileAvatar, { props: { profile: profile(fields) } });

describe('ProfileAvatar', () => {
  it("shows the first letter of the profile's label, else its login, else its server", () => {
    expect(avatar({ label: 'work', login: 'ann' }).text()).toBe('W');
    expect(avatar({ login: 'ann' }).text()).toBe('A');
    expect(avatar({}).text()).toBe('R');
  });

  it('keeps the same colour for a profile, and varies it between profiles', () => {
    const colour = (id: string) => avatar({ id }).get('.v-avatar').attributes('style');
    expect(colour('a1b2')).toBe(colour('a1b2'));
    const colours = new Set(['p1', 'p2', 'p3', 'p4', 'p5', 'p6'].map(colour));
    expect(colours.size).toBeGreaterThan(1);
  });
});
