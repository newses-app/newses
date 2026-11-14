import { describe, expect, it, vi } from 'vitest';
import { ref } from 'vue';
import { useIconSrc } from './useIconSrc.ts';

const session = ref<{ iconsPath: string } | undefined>({ iconsPath: '/feed-icons/abc' });
vi.mock('./useSession.ts', () => ({ useSession: () => ({ session }) }));

describe('useIconSrc', () => {
  it("gives each subscription's icon from where the session keeps them", () => {
    const src = useIconSrc();
    expect(src({ id: 7, iconUrl: 'https://example.com/favicon.ico' })).toBe(
      'https://example.com/favicon.ico',
    );
    expect(src({ id: 7, iconUrl: null })).toBeNull();
  });
});
