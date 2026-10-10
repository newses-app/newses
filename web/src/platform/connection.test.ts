import { describe, expect, it, vi } from 'vitest';
import { memoryBridge } from './bridge.ts';
import { createConnection } from './connection.ts';

async function connected() {
  const bridge = memoryBridge();
  await bridge.setServerUrl('https://one.example');
  await bridge.setToken('t1');
  const connection = createConnection(bridge);
  await connection.load();
  return { bridge, connection };
}

describe('createConnection', () => {
  it('loads the stored server and token', async () => {
    const { connection } = await connected();
    expect(connection.state).toEqual({ serverUrl: 'https://one.example', token: 't1' });
  });

  it('starts at the connect screen on first run', async () => {
    const connection = createConnection(memoryBridge());
    await connection.load();
    expect(connection.state).toEqual({ serverUrl: null, token: null });
  });

  it('keeps the token on sign-in and forgets it when the session ends', async () => {
    const bridge = memoryBridge();
    const connection = createConnection(bridge);
    await connection.signedIn('t2');
    expect(connection.state.token).toBe('t2');
    expect(await bridge.getToken()).toBe('t2');
    await connection.signedOut();
    expect(connection.state.token).toBeNull();
    expect(await bridge.getToken()).toBeNull();
  });

  it('signs out of the old server when changing servers', async () => {
    const { bridge, connection } = await connected();
    const revoke = vi.fn(() => Promise.resolve());
    await connection.setServer('https://two.example', revoke);
    expect(revoke).toHaveBeenCalledOnce();
    expect(connection.state).toEqual({ serverUrl: 'https://two.example', token: null });
    expect(await bridge.getServerUrl()).toBe('https://two.example');
    expect(await bridge.getToken()).toBeNull();
  });

  it('changes servers even when the old one cannot revoke the session', async () => {
    const { connection } = await connected();
    await connection.setServer('https://two.example', () => Promise.reject(new Error('offline')));
    expect(connection.state).toEqual({ serverUrl: 'https://two.example', token: null });
  });

  it('keeps the session when the same server is chosen again', async () => {
    const { connection } = await connected();
    const revoke = vi.fn(() => Promise.resolve());
    await connection.setServer('https://one.example', revoke);
    expect(revoke).not.toHaveBeenCalled();
    expect(connection.state.token).toBe('t1');
  });
});
