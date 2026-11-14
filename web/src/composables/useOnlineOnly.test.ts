import { describe, expect, it, vi } from 'vitest';
import { useUiStore } from '../stores/ui.ts';
import { connectivity } from '../test/connectivity.ts';
import { withSetup } from '../test/mount.ts';
import { useOnlineOnly } from './useOnlineOnly.ts';

vi.mock('../offline/connectivity.ts', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  ...(await import('../test/connectivity.ts')),
}));

describe('useOnlineOnly', () => {
  it('runs the action while online, and otherwise says it needs a connection', () => {
    connectivity.value = 'online';
    const { result, pinia } = withSetup(() => useOnlineOnly());
    const ui = useUiStore(pinia);
    const action = vi.fn();
    const guarded = result.whenOnline(action);

    expect(result.online.value).toBe(true);
    guarded(1, 'a');
    expect(action).toHaveBeenCalledWith(1, 'a');
    expect(ui.notice).toBeNull();

    connectivity.value = 'unreachable';
    expect(result.online.value).toBe(false);
    guarded(2, 'b');
    expect(action).toHaveBeenCalledOnce();
    expect(ui.notice).toEqual({ text: 'This needs a connection to the server.', error: false });
  });
});
