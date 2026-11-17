import { describe, expect, it } from 'vitest';
import { pluginChanges } from './plugin-changes.ts';

describe('pluginChanges', () => {
  it('lists, per stage, plugins added, changed, and removed', () => {
    const stored = {
      stages: [
        { name: 'dev', plugins: ['@newses/plugin-webhook@1.0.0', 'old@2.0.0', 'same@1.0.0'] },
        { name: 'prod' },
      ],
    };
    const local = {
      stages: [
        { name: 'dev', plugins: ['@newses/plugin-webhook@1.1.0', 'same@1.0.0', 'new@0.1.0'] },
        { name: 'prod', plugins: [] },
      ],
    };
    expect(pluginChanges(stored, local)).toEqual([
      'dev: @newses/plugin-webhook 1.0.0 → 1.1.0, + new@0.1.0, - old@2.0.0',
    ]);
    expect(pluginChanges(null, { stages: [{ name: 'prod', plugins: ['a@1.0.0'] }] })).toEqual([
      'prod: + a@1.0.0',
    ]);
    expect(pluginChanges(local, local)).toEqual([]);
  });
});
