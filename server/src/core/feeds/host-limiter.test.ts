import { describe, expect, it } from 'vitest';
import { HostLimiter } from './host-limiter.ts';

describe('HostLimiter', () => {
  it('caps concurrency per host without blocking other hosts', async () => {
    const limiter = new HostLimiter(2);
    const active = new Map<string, number>();
    let peakA = 0;
    let peakB = 0;
    const task = (host: string) =>
      limiter.run(host, async () => {
        active.set(host, (active.get(host) ?? 0) + 1);
        peakA = Math.max(peakA, active.get('a') ?? 0);
        peakB = Math.max(peakB, active.get('b') ?? 0);
        await new Promise((resolve) => setTimeout(resolve, 5));
        active.set(host, (active.get(host) ?? 0) - 1);
        return host;
      });
    const hosts = ['a', 'a', 'a', 'a', 'a', 'b', 'b', 'b'];
    const results = await Promise.all(hosts.map((host) => task(host)));
    expect(results).toEqual(hosts);
    expect(peakA).toBe(2);
    expect(peakB).toBe(2);
  });
});

describe('HostLimiter spacing', () => {
  it('spaces task starts per host', async () => {
    const limiter = new HostLimiter(2, 40);
    const starts: Record<'a' | 'b', number[]> = { a: [], b: [] };
    const task = (host: 'a' | 'b') =>
      limiter.run(host, () => {
        starts[host].push(Date.now());
        return Promise.resolve();
      });
    await Promise.all([task('a'), task('a'), task('a'), task('b')]);
    const [a0 = 0, a1 = 0, a2 = 0] = starts.a;
    expect(a1 - a0).toBeGreaterThanOrEqual(35);
    expect(a2 - a1).toBeGreaterThanOrEqual(35);
    expect((starts.b[0] ?? 0) - a0).toBeLessThan(35);
  });
});
