import { describe, expect, it } from 'vitest';
import { memoryBridge, type PlatformBridge, selectBridge, webBridge } from './bridge.ts';

describe('selectBridge', () => {
  it('prefers the bridge a shell injected', () => {
    const injected: PlatformBridge = { ...webBridge, platform: 'desktop', appVersion: '1.2.3' };
    expect(selectBridge(injected, true)).toBe(injected);
    expect(selectBridge(injected, false)).toBe(injected);
  });

  it('uses the browser bridge for the web build', () => {
    expect(selectBridge(undefined, false)).toBe(webBridge);
  });

  it('keeps profiles and tokens in memory for the native build outside a shell', async () => {
    const bridge = selectBridge(undefined, true);
    expect(bridge).not.toBe(webBridge);
    const profile = await bridge.addProfile('https://reader.example');
    await bridge.setActiveProfile(profile.id);
    await bridge.setToken('t0k');
    expect(await bridge.getProfiles()).toMatchObject({
      profiles: [{ serverUrl: 'https://reader.example', signedIn: true }],
      active: profile.id,
    });
    expect(await bridge.getToken()).toBe('t0k');
    await bridge.clearToken();
    expect(await bridge.getToken()).toBeNull();
  });
});

describe('webBridge', () => {
  it('keeps no server or token: the page origin and cookie apply', async () => {
    await webBridge.setToken('t0k');
    expect(await webBridge.getToken()).toBeNull();
    expect(await webBridge.getProfiles()).toEqual({ profiles: [], active: null });
    await expect(webBridge.addProfile('https://reader.example')).rejects.toThrow();
  });
});

describe('webBridge network', () => {
  it('reports the browser network and its changes until the listener is removed', async () => {
    expect(await webBridge.getNetwork()).toEqual({ connected: navigator.onLine, wifi: null });
    const seen: boolean[] = [];
    const remove = webBridge.onNetworkChange((status) => seen.push(status.connected));
    window.dispatchEvent(new Event('offline'));
    remove();
    window.dispatchEvent(new Event('online'));
    expect(seen).toHaveLength(1);
  });
});

describe('memoryBridge', () => {
  it('starts empty each time', async () => {
    await memoryBridge().addProfile('https://reader.example');
    expect(await memoryBridge().getProfiles()).toEqual({ profiles: [], active: null });
  });
});
